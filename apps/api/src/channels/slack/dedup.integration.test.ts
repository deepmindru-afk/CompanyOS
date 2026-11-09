/**
 * Real-Postgres contract for the inbound Slack event claim (KRTX-4443).
 *
 * A per-project (BYO) Slack app is a separate Slack app with its own event id
 * space, so two projects can legitimately receive the same `event_id`. The claim
 * that makes the webhook idempotent must therefore be scoped per project: a
 * delivery claimed for one project must never suppress the same event for
 * another project. Within one project a redelivery is still suppressed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chatEventDedup } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { db } from '../../shared/db';
import { alreadyHandled } from './dedup';

const PROJECT_A = '3f1c2b7e-0000-4000-8000-00000000d0a1';
const PROJECT_B = '3f1c2b7e-0000-4000-8000-00000000d0b2';
const EVENT_ID = 'Ev-krtx-4443-1';
const EVENT_ID_CANONICAL = 'Ev-krtx-4443-2';

const KEYS = [
  `slack:event:${EVENT_ID}`,
  `slack:event:${PROJECT_A}:${EVENT_ID}`,
  `slack:event:${PROJECT_B}:${EVENT_ID}`,
  `slack:event:${EVENT_ID_CANONICAL}`,
];

async function reset(): Promise<void> {
  await db.delete(chatEventDedup).where(inArray(chatEventDedup.eventId, KEYS));
}

afterAll(reset);

describe('the Slack event claim is scoped to the project that received it', () => {
  test('one project claiming an event_id does not suppress another project’s delivery', async () => {
    await reset();

    expect(await alreadyHandled(EVENT_ID, { projectId: PROJECT_A })).toBe(false);
    expect(await alreadyHandled(EVENT_ID, { projectId: PROJECT_B })).toBe(false);
  });

  test('a redelivery to the same project is still suppressed', async () => {
    await reset();

    expect(await alreadyHandled(EVENT_ID, { projectId: PROJECT_A })).toBe(false);
    expect(await alreadyHandled(EVENT_ID, { projectId: PROJECT_A })).toBe(true);
  });

  test('the canonical app keeps its own scope and still suppresses its redeliveries', async () => {
    await reset();

    expect(await alreadyHandled(EVENT_ID_CANONICAL)).toBe(false);
    expect(await alreadyHandled(EVENT_ID_CANONICAL)).toBe(true);
    expect(await alreadyHandled(EVENT_ID_CANONICAL, { projectId: PROJECT_A })).toBe(false);
  });

  test('an expired claim frees the key: the delivery is processed, not suppressed', async () => {
    await reset();

    // A claim left behind by a failed release (or an old redelivery) holds the
    // key only until its TTL: past it, the claim row is re-taken — refreshed,
    // and reported as NOT handled — so a durable redelivery scheduled past the
    // TTL can run the event, while a live claim still suppresses its replay.
    await db.insert(chatEventDedup).values({
      eventId: `slack:event:${EVENT_ID}`,
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await alreadyHandled(EVENT_ID)).toBe(false);
    expect(await alreadyHandled(EVENT_ID)).toBe(true); // the re-taken claim is live again
  });
});
