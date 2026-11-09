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
mock.module('../lib/logger', () => ({
  logger: {
    warn: (message: string, context?: Record<string, unknown>) => {
      warnings.push({ message, context });
    },
    error: () => {},
  },
}));

const { runWebhookWork, recordClaim } = await import('./webhook-work');
const { inflightCount, resetDrainForTests } = await import('../shared/drain');

beforeEach(() => {
  deleted.length = 0;
  warnings.length = 0;
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

  test('an ack budget that elapses warns, and the late finish logs its duration', async () => {
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
    finish();
    await Bun.sleep(30);
    const late = warnings.find((w) => w.message.includes('finished after the ack'));
    expect(late).toBeDefined();
    expect(late?.context?.label).toBe('slack-oauth-event');
    expect(late?.context?.workMs).toBeGreaterThanOrEqual(20);
  });

  test('work inside the ack budget stays silent', async () => {
    const outcome = await runWebhookWork('t', async () => {}, { ackWaitMs: 500 });
    expect(outcome).toBe('done');
    expect(warnings).toHaveLength(0);
  });
});
