/**
 * Integration test (real local PostgreSQL): the "waiting for a human" shell of
 * a Slack question and a Slack review card (KRTX-4558
 * `dedupe-waiting-turn-shell`).
 *
 * postQuestion and postReviewCard close out the in-flight plan identically:
 * finalize with `unfinished: true` under their own title (the last in-flight
 * step left `pending`), delete the turn row, then post below it. Real: the
 * turn row lifecycle (load, finalize, delete). Faked: only Slack's HTTP
 * surface and the bot token read.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatTurnStreams } from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realSlackApi from '../slack-api';
import * as realInstallStore from '../install-store';
import { STREAM_TTL_MS } from './app';
import { db } from '../../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';

const posted: Array<{ channel: string; threadTs?: string; blocks: unknown[] }> = [];
const updated: Array<{ channel: string; ts: string; title: string; blocks: Record<string, unknown>[]; tasks: unknown[] }> = [];
const plainPosted: Array<{ channel: string; text: string }> = [];

mock.module('../slack-api', () => ({
  ...realSlackApi,
  postBlocks: async (_t: string, channel: string, _x: string, blocks: unknown[], threadTs?: string) => {
    posted.push({ channel, threadTs, blocks });
    return '900.0100';
  },
  updateBlocks: async (_t: string, channel: string, ts: string, title: string, blocks: Record<string, unknown>[]) => {
    const plan = blocks.find((b) => (b as { type?: string }).type === 'plan') as
      | { tasks?: unknown[] }
      | undefined;
    updated.push({ channel, ts, title, blocks, tasks: plan?.tasks ?? [] });
    return true;
  },
  postMessage: async (_t: string, channel: string, text: string) => {
    plainPosted.push({ channel, text });
    return '901.0100';
  },
}));
mock.module('../install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

const { postQuestion } = await import('./questions');
const { postReviewCard } = await import('./review');

const TEAM = 'T0WAITINGTURN';
const CHANNEL = 'C0WAITINGTURN';
const EVENT = { type: 'message', channel: CHANNEL, user: 'U0', ts: '1762000000.000001' } as const;

let seeded: SeededProject[] = [];
const sessionIds: string[] = [];

function newSession(): string {
  const sessionId = crypto.randomUUID();
  sessionIds.push(sessionId);
  return sessionId;
}

async function seedInFlightTurn(sessionId: string, project: SeededProject): Promise<void> {
  await db.insert(chatTurnStreams).values({
    sessionId,
    projectId: project.project_id,
    teamId: TEAM,
    channel: CHANNEL,
    triggerTs: EVENT.ts,
    messageTs: '1762000000.000500',
    finalized: false,
    steps: [{ id: 'step1', title: 'Drafting', status: 'in_progress' }],
    originatingEvent: EVENT,
    expiresAt: new Date(Date.now() + STREAM_TTL_MS),
    updatedAt: new Date(),
  });
}

async function rowOf(sessionId: string): Promise<typeof chatTurnStreams.$inferSelect | undefined> {
  const [row] = await db.select().from(chatTurnStreams).where(eq(chatTurnStreams.sessionId, sessionId)).limit(1);
  return row;
}

beforeEach(() => {
  posted.length = 0;
  updated.length = 0;
  plainPosted.length = 0;
});

afterAll(async () => {
  for (const sessionId of sessionIds) await db.delete(chatTurnStreams).where(eq(chatTurnStreams.sessionId, sessionId));
  removeSeeded(seeded);
});

describe('a question closes the in-flight plan, then asks below it', () => {
  test('the plan is finalized with its own title, the in-flight step left pending, and the turn deleted', async () => {
    const project = await seedProject('waiting-turn-question');
    seeded.push(project);
    const sessionId = newSession();
    await seedInFlightTurn(sessionId, project);

    const result = await postQuestion(sessionId, [
      { question: 'Which provider do we use?', header: 'Provider', options: [{ label: 'Platinum', description: 'the reference' }] },
    ]);

    expect(result.ok).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.title).toBe('Waiting for your answer');
    expect(updated[0]?.tasks[0]).toEqual(expect.objectContaining({ task_id: 'step1', status: 'pending' }));
    expect(updated[0]?.ts).toBe('1762000000.000500');
    expect(await rowOf(sessionId)).toBeUndefined();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.threadTs).toBe('1762000000.000001');
  });

  test('no live turn asks nothing and touches no row', async () => {
    const sessionId = newSession();
    const result = await postQuestion(sessionId, [
      { question: 'Which provider?', header: 'Provider', options: [{ label: 'Platinum', description: '' }] },
    ]);
    expect(result).toEqual({ ok: false, error: 'No active Slack turn for this session.' });
    expect(updated).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('a review card closes the in-flight plan, then asks for a decision below it', () => {
  test('the plan is finalized with its own title and the turn deleted', async () => {
    const project = await seedProject('waiting-turn-review');
    seeded.push(project);
    const sessionId = newSession();
    await seedInFlightTurn(sessionId, project);

    const result = await postReviewCard(sessionId, {
      review_item_id: 'rev-1',
      kind: 'approval',
      risk: 'low',
      title: 'Ship the connector change',
      summary: 'A read about to reach a customer.',
    });

    expect(result.ok).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.title).toBe('Waiting for your decision');
    expect(updated[0]?.tasks[0]).toEqual(expect.objectContaining({ task_id: 'step1', status: 'pending' }));
    expect(await rowOf(sessionId)).toBeUndefined();
    expect(posted).toHaveLength(1);
  });

  test('no live turn posts nothing', async () => {
    const sessionId = newSession();
    const result = await postReviewCard(sessionId, {
      review_item_id: 'rev-1',
      kind: 'approval',
      risk: 'low',
      title: 'Ship the connector change',
      summary: 'A read about to reach a customer.',
    });
    expect(result).toEqual({ ok: false, error: 'No active Slack turn for this session.' });
    expect(updated).toEqual([]);
    expect(posted).toEqual([]);
  });
});
