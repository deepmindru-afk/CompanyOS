/**
 * Integration test (real local PostgreSQL): the claim sites of the Slack
 * channel (KRTX-4558 `dedupe-expiring-key-claim`).
 *
 * Five functions guard a webhook/turn against double work with one INSERT …
 * ON CONFLICT DO NOTHING on `chat_event_dedup`; they differ only in the key
 * they claim, the TTL, the telemetry they record and the branch a DB error
 * takes (fail-open or fail-closed). This file pins that behavior per site
 * BEFORE `dedup.ts` collapses the copies onto one helper: the first caller
 * wins, every later caller loses, the row carries the site's TTL, and a DB
 * error answers exactly the site's policy value.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chatEventDedup } from '@kortix/db';
import { like, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { EVENT_DEDUPE_TTL_MS, STREAM_TTL_MS } from './app';
import { alreadyHandled, claimInboundMessage, claimThreadErrorNotice } from './dedup';
import { claimThreadCreate } from './session';
import { claimAnswerRescue } from './turn';

const PROJECT_A = '3f1c2b7e-0000-4000-8000-00000000d0a1';
const PROJECT_B = '3f1c2b7e-0000-4000-8000-00000000d0b2';
const TEAM = 'T0CLAIMMATRIX';
const THREAD = '1755000000.000100';
const SESSION = 'sess-claim-matrix-1';

const ERROR_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // dedup.ts holds it privately

/** Rows this file claimed, matched by the key prefix each site generates. */
async function resetClaims(): Promise<void> {
  await db.delete(chatEventDedup).where(
    or(
      like(chatEventDedup.eventId, 'slack:event:%km-event-1%'),
      like(chatEventDedup.eventId, `slack:msg:${PROJECT_A}:${TEAM}:C0CLAIM%`),
      like(chatEventDedup.eventId, `slack:threaderror:${TEAM}%`),
      like(chatEventDedup.eventId, 'slack:threadcreate:T0CLAIM%'),
      like(chatEventDedup.eventId, `slack:answerrescue:${SESSION}%`),
    ),
  );
}

const BREAK_CONSTRAINT = 'claim_matrix_db_error';

/** Every claim INSERT fails with a constraint violation: a DB error like an
 * outage, without mocking a single statement under test. */
async function breakClaims(): Promise<void> {
  await db
    .execute(sql.raw(`alter table kortix.chat_event_dedup add constraint ${BREAK_CONSTRAINT} check (false) not valid`));
}

async function healClaims(): Promise<void> {
  await db.execute(sql.raw(`alter table kortix.chat_event_dedup drop constraint if exists ${BREAK_CONSTRAINT}`));
}

beforeEach(async () => {
  await healClaims();
  await resetClaims();
});

afterAll(async () => {
  await healClaims();
  await resetClaims();
});

describe('first caller wins, later callers lose', () => {
  test('alreadyHandled: the first delivery is not handled, its redelivery is', async () => {
    expect(await alreadyHandled('km-event-1')).toBe(false);
    expect(await alreadyHandled('km-event-1')).toBe(true);
  });

  test('alreadyHandled: a per-project claim never suppresses another project and vice versa', async () => {
    expect(await alreadyHandled('km-event-1')).toBe(false);
    expect(await alreadyHandled('km-event-1', { projectId: PROJECT_A })).toBe(false);
    expect(await alreadyHandled('km-event-1', { projectId: PROJECT_B })).toBe(false);
    expect(await alreadyHandled('km-event-1', { projectId: PROJECT_A })).toBe(true);
  });

  test('claimInboundMessage: the first delivery may run, its retry may not', async () => {
    const key = `slack:msg:${PROJECT_A}:${TEAM}:C0CLAIM:10000000.000100`;
    expect(await claimInboundMessage(key)).toBe(true);
    expect(await claimInboundMessage(key)).toBe(false);
    const nextKey = `slack:msg:${PROJECT_A}:${TEAM}:C0CLAIM:10000000.000200`;
    expect(await claimInboundMessage(nextKey)).toBe(true);
  });

  test('claimThreadErrorNotice: the first failed delivery tells once, later ones stay silent', async () => {
    expect(await claimThreadErrorNotice(TEAM, THREAD)).toBe(true);
    expect(await claimThreadErrorNotice(TEAM, THREAD)).toBe(false);
  });

  test('claimThreadErrorNotice: empty coordinates claim nothing', async () => {
    expect(await claimThreadErrorNotice('', THREAD)).toBe(false);
    expect(await claimThreadErrorNotice(TEAM, '')).toBe(false);
  });

  test('claimThreadCreate: one creator per thread, every loser joins', async () => {
    expect(await claimThreadCreate('slack:threadcreate:T0CLAIM:C0CLAIM')).toBe(true);
    expect(await claimThreadCreate('slack:threadcreate:T0CLAIM:C0CLAIM')).toBe(false);
  });

  test('claimAnswerRescue: one rescue per distinct answer', async () => {
    expect(await claimAnswerRescue(SESSION, 'need a raise')).toBe(true);
    expect(await claimAnswerRescue(SESSION, 'need a raise')).toBe(false);
    expect(await claimAnswerRescue(SESSION, 'still thinking')).toBe(true);
  });
});

describe('each site claims with its own TTL', () => {
  test('the envelope claim expires with the event-dedup TTL', async () => {
    const key = `slack:event:${'km-event-1'}`;
    const before = Date.now();
    expect(await alreadyHandled('km-event-1')).toBe(false);
    await assertOnlyRowTtl(key, before + EVENT_DEDUPE_TTL_MS);
  });

  test('the thread-error notice claim outlives the thread by a month', async () => {
    const before = Date.now();
    expect(await claimThreadErrorNotice(TEAM, THREAD)).toBe(true);
    await assertOnlyRowTtl(`slack:threaderror:${TEAM}:${THREAD}`, before + ERROR_NOTICE_TTL_MS);
  });

  test('the answer-rescue claim lives as long as a turn may stream', async () => {
    const before = Date.now();
    expect(await claimAnswerRescue(SESSION, 'need a raise')).toBe(true);
    await assertOnlyRowTtl(`slack:answerrescue:${SESSION}:`, before + STREAM_TTL_MS);
  });
});

/** The one row still held must be this site's key and expire at `expected` (±1 min). */
async function assertOnlyRowTtl(prefix: string, expected: number): Promise<void> {
  const rows = await db.select().from(chatEventDedup);
  const held = rows.find((r) => r.eventId.startsWith(prefix));
  expect(held?.eventId).toContain(prefix);
  if (!held) return;
  expect(held.expiresAt.getTime()).toBeGreaterThan(expected - 60_000);
  expect(held.expiresAt.getTime()).toBeLessThan(expected + 60_000);
}

describe('a DB error answers each site’s own policy', () => {
  beforeEach(breakClaims);
  afterEach(healClaims);

  test('alreadyHandled fails open: the event is not considered handled', async () => {
    expect(await alreadyHandled('km-event-1')).toBe(false);
  });

  test('claimInboundMessage fails open: the message still runs', async () => {
    expect(await claimInboundMessage(`slack:msg:${PROJECT_A}:${TEAM}:C0CLAIM:10000000.000100`)).toBe(true);
  });

  test('claimThreadErrorNotice fails closed: the notice stays silent', async () => {
    expect(await claimThreadErrorNotice(TEAM, THREAD)).toBe(false);
  });

  test('claimThreadCreate fails open: the create still proceeds', async () => {
    expect(await claimThreadCreate('slack:threadcreate:T0CLAIM:C0CLAIM')).toBe(true);
  });

  test('claimAnswerRescue fails closed: the post is suppressed', async () => {
    expect(await claimAnswerRescue(SESSION, 'need a raise')).toBe(false);
  });
});
