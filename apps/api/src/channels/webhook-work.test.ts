import { beforeEach, describe, expect, mock, test } from 'bun:test';

const deleted: number[] = [];
mock.module('../shared/db', () => ({
  db: {
    delete: () => ({
      where: () => {
        deleted.push(1);
        return Promise.resolve();
      },
    }),
  },
}));

const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
const errors: Array<{ message: string; context?: Record<string, unknown> }> = [];
mock.module('../lib/logger', () => ({
  logger: {
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
    error: (message: string, context?: Record<string, unknown>) => {
      errors.push({ message, context });
    },
  },
}));

const { runWebhookWork, recordClaim } = await import('./webhook-work');
const { inflightCount, resetDrainForTests } = await import('../shared/drain');
const { runWithContext } = await import('../lib/request-context');
const { beginStage } = await import('../lib/server-timing');

beforeEach(() => {
  deleted.length = 0;
  warnings.length = 0;
  errors.length = 0;
  resetDrainForTests();
});

describe('runWebhookWork', () => {
  test('success keeps the claims and reports done', async () => {
    const outcome = await runWebhookWork('t', async () => recordClaim('k1'), { ackWaitMs: 500 });
    expect(outcome).toBe('done');
    expect(deleted).toHaveLength(0);
  });

  test('a fast failure releases the claims and reports failed', async () => {
    const outcome = await runWebhookWork(
      't',
      async () => {
        recordClaim('k1');
        throw new Error('db blip');
      },
      { ackWaitMs: 500 },
    );
    expect(outcome).toBe('failed');
    expect(deleted).toHaveLength(1);
  });

  test('a failure with no claims deletes nothing', async () => {
    await runWebhookWork('t', async () => { throw new Error('x'); }, { ackWaitMs: 500 });
    expect(deleted).toHaveLength(0);
  });

  test('slow work acks pending, stays counted for the drain, and releases when it fails later', async () => {
    let fail!: () => void;
    const outcome = await runWebhookWork(
      't',
      async () => {
        recordClaim('k1');
        await new Promise<void>((_, reject) => (fail = () => reject(new Error('late'))));
      },
      { ackWaitMs: 20 },
    );
    expect(outcome).toBe('pending');
    expect(inflightCount()).toBe(1);
    fail();
    await Bun.sleep(20);
    expect(inflightCount()).toBe(0);
    expect(deleted).toHaveLength(1);
  });

  test('ackWaitMs 0 returns at once', async () => {
    const outcome = await runWebhookWork('t', () => new Promise<void>(() => {}), { ackWaitMs: 0 });
    expect(outcome).toBe('pending');
  });

  test('an ack budget that elapses warns, and the late finish logs its duration and stage split', async () => {
    let finish!: () => void;
    const outcome = await runWebhookWork(
      'slack-oauth-event',
      async () => {
        await new Promise<void>((resolve) => (finish = resolve));
      },
      { ackWaitMs: 20 },
    );
    expect(outcome).toBe('pending');
    const elapsed = warnings.find((w) => w.message.includes('ack budget elapsed'));
    expect(elapsed).toBeDefined();
    expect(elapsed?.context?.label).toBe('slack-oauth-event');
    expect(elapsed?.context?.dbMs).toBe(0);
    expect(elapsed?.context?.httpMs).toBe(0);
    finish();
    await Bun.sleep(30);
    const late = warnings.find((w) => w.message.includes('finished after the ack'));
    expect(late).toBeDefined();
    expect(late?.context?.label).toBe('slack-oauth-event');
    expect(late?.context?.workMs).toBeGreaterThanOrEqual(20);
    expect(late?.context?.dbMs).toBe(0);
  });

  test('sync work that outlasts the budget but wins the race stays silent', async () => {
    const outcome = await runWebhookWork(
      't',
      async () => {
        // Blocks the loop past the budget: the timer fires late, the work
        // settles first, and the request log already shows the true duration.
        const end = Date.now() + 30;
        while (Date.now() < end) {}
      },
      { ackWaitMs: 20 },
    );
    expect(outcome).toBe('done');
    expect(warnings).toHaveLength(0);
  });

  test('stage fields carry real db and http time inside a request scope', async () => {
    let finish!: () => void;
    await runWithContext('POST', '/v1/webhooks/slack', async () => {
      beginStage('http'); // left in-flight: counts up at every snapshot
      const outcome = await runWebhookWork(
        'slack-oauth-event',
        async () => {
          const dbEnd = beginStage('db');
          await Bun.sleep(10);
          dbEnd();
          await new Promise<void>((resolve) => (finish = resolve));
        },
        { ackWaitMs: 20 },
      );
      expect(outcome).toBe('pending');
      const elapsed = warnings.find((w) => w.message.includes('ack budget elapsed'));
      expect(elapsed).toBeDefined();
      expect(elapsed?.context?.dbMs).toBeGreaterThanOrEqual(5);
      expect(elapsed?.context?.httpMs).toBeGreaterThan(0);
      finish();
      await Bun.sleep(30);
      const late = warnings.find((w) => w.message.includes('finished after the ack'));
      expect(late).toBeDefined();
      expect(late?.context?.dbMs).toBeGreaterThanOrEqual(5);
      expect(late?.context?.httpMs).toBeGreaterThan(0);
    });
  });

  test('a failure after the ack carries the stage split on the error log', async () => {
    let fail!: () => void;
    await runWithContext('POST', '/v1/webhooks/slack', async () => {
      const outcome = await runWebhookWork(
        't',
        async () => {
          const dbEnd = beginStage('db');
          await Bun.sleep(10);
          dbEnd();
          await new Promise<void>((_, reject) => (fail = () => reject(new Error('late'))));
        },
        { ackWaitMs: 20 },
      );
      expect(outcome).toBe('pending');
      fail();
      await Bun.sleep(30);
      const err = errors.find((e) => e.message.includes('handler failed'));
      expect(err).toBeDefined();
      expect(err?.context?.workMs).toBeGreaterThanOrEqual(20);
      expect(err?.context?.dbMs).toBeGreaterThanOrEqual(5);
    });
  });

  test('work inside the ack budget stays silent', async () => {
    const outcome = await runWebhookWork('t', async () => {}, { ackWaitMs: 500 });
    expect(outcome).toBe('done');
    expect(warnings).toHaveLength(0);
  });

  test('a failure after the ack schedules the redelivery; a fast failure does not', async () => {
    let fail!: () => void;
    const lost: number[] = [];
    const outcome = await runWebhookWork(
      't',
      async () => {
        await new Promise<void>((_, reject) => (fail = () => reject(new Error('late'))));
      },
      { ackWaitMs: 20, onLost: () => void lost.push(1) },
    );
    expect(outcome).toBe('pending'); // the ack went out; the provider will not retry
    fail();
    await Bun.sleep(30);
    expect(lost).toHaveLength(1);

    const fastLost: number[] = [];
    const fast = await runWebhookWork(
      't2',
      async () => {
        throw new Error('fast');
      },
      { ackWaitMs: 500, onLost: () => void fastLost.push(1) },
    );
    expect(fast).toBe('failed'); // answered 500: Slack's retry is the redelivery
    expect(fastLost).toHaveLength(0);
  });

  test('awaitSettlement holds the caller until the work settles', async () => {
    const lost: number[] = [];
    const done = await runWebhookWork('t', async () => {
      await Bun.sleep(60);
    }, { ackWaitMs: 20, awaitSettlement: true });
    expect(done).toBe('done');
    const outcome = await runWebhookWork(
      't2',
      async () => {
        await Bun.sleep(60);
        throw new Error('late');
      },
      { ackWaitMs: 20, awaitSettlement: true, onLost: () => void lost.push(1) },
    );
    expect(outcome).toBe('failed'); // the caller sees the settled outcome, not 'pending'
    expect(lost).toHaveLength(1);
  });

  test('a redelivery scheduler that itself fails is logged, never thrown', async () => {
    let fail!: () => void;
    const outcome = await runWebhookWork(
      't',
      async () => {
        await new Promise<void>((_, reject) => (fail = () => reject(new Error('late'))));
      },
      {
        ackWaitMs: 20,
        onLost: () => {
          throw new Error('enqueue down');
        },
      },
    );
    expect(outcome).toBe('pending');
    fail();
    await Bun.sleep(30);
    const logged = errors.find((e) => e.message.includes('redelivery scheduling failed'));
    expect(logged).toBeDefined();
  });
});
