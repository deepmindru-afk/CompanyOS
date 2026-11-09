import { eq, lt } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../../shared/db';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { recordClaim } from '../webhook-work';

// Cross-replica dedup. Slack can redeliver the same event_id (retries); with >1
// API replica an in-memory set only dedups within one process, so a redelivery
// to another replica re-fires the turn. An INSERT … ON CONFLICT DO NOTHING makes
// "already handled?" one shared decision: a row came back ⇒ we're the first to
// claim it; empty ⇒ someone already has.
//
// The claim is namespaced by the project that received it: a per-project (BYO)
// Slack app is a separate Slack app with its own event id space, so two projects
// can receive the same event_id and each must handle it. The canonical app keeps
// a scope of its own. Unlike this envelope layer, the message gate below is
// namespaced by TEAM, not project — two BYO apps in one workspace share it; that
// sibling gap is KRTX-4447, out of scope here by the issue's own instruction.
export async function alreadyHandled(
  eventId: string | undefined,
  scope?: { projectId: string },
): Promise<boolean> {
  if (!eventId) return false;
  const key = scope ? `slack:event:${scope.projectId}:${eventId}` : `slack:event:${eventId}`;
  try {
    const expiresAt = new Date(Date.now() + EVENT_DEDUPE_TTL_MS);
    // An EXPIRED claim must not block a fresh delivery (a redelivery after the
    // TTL, or a claim whose failed release was left behind): the conflict
    // re-takes it — the row's TTL is refreshed and returned, so exactly-once
    // still holds for a live claim while a stale one frees the key.
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt })
      .onConflictDoUpdate({
        target: chatEventDedup.eventId,
        set: { expiresAt },
        setWhere: lt(chatEventDedup.expiresAt, new Date()),
      })
      .returning({ eventId: chatEventDedup.eventId });
    if (inserted.length > 0) recordClaim(key);
    return inserted.length === 0;
  } catch (err) {
    // Never let a dedup hiccup wedge the webhook — fail open (process the event).
    console.warn('[slack-webhook] event dedup check failed', err);
    return false;
  }
}

// ── Exactly-once gate for an inbound user MESSAGE ────────────────────────────
// `alreadyHandled` dedups the event ENVELOPE (event_id), but ONE user message can
// reach us as several envelopes with DIFFERENT event_ids — Slack delivers a
// channel @mention as both an `app_mention` AND a `message`, and redeliveries can
// arrive on different replicas. Every one of them, however, carries the SAME
// message coordinates `(team, channel, ts)`. Claiming THAT identity once — via the
// same pooler-safe INSERT … ON CONFLICT on the shared dedup table — guarantees a
// single agent run per message no matter the delivery path (retry, fan-out,
// concurrent replicas). This is the keystone that makes the turn flow idempotent:
// without it, a redelivery that lands after the thread→session mapping exists is
// treated as a brand-new follow-up and runs the agent a second time.
//
// The claim belongs to the RECEIVING PROJECT, never to the message alone. Every
// BYO Slack app of a workspace receives every channel message, so one user
// message legitimately arrives here once per installed project with identical
// coordinates. Without the project in the key the first project's claim
// suppressed every other project's delivery (CWE-863, KRTX-4447). Inside one
// project the coordinates still collapse the siblings, so exactly-once holds
// where it is owed.
export function inboundMessageKey(
  projectId: string,
  teamId: string,
  event: { channel?: string; ts?: string },
): string | null {
  if (!projectId || !teamId || !event.channel || !event.ts) return null;
  return `slack:msg:${projectId}:${teamId}:${event.channel}:${event.ts}`;
}

// Returns true iff WE are the first to claim this message → run it. Empty ⇒ a
// retry / fan-out / sibling replica already owns it → must NOT run again.
// Fail-OPEN on a DB error (mirrors `alreadyHandled`/`claimThreadCreate`): the
// atomic INSERT is what guarantees exactly-once under healthy operation — the
// entire incident class — and we'd rather risk a rare duplicate during a DB
// outage than silently drop a user's message. Errors are logged loudly.
export async function claimInboundMessage(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({ eventId: key, expiresAt: new Date(Date.now() + EVENT_DEDUPE_TTL_MS) })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    if (inserted.length > 0) recordClaim(key);
    return inserted.length > 0;
  } catch (err) {
    console.error('[slack-webhook] inbound message claim failed (fail-open)', err);
    return true;
  }
}

// ── One-shot "this thread's session terminally failed" notice ────────────────
// A thread whose session hit a terminal fault KEEPS its mapping — we never
// silently recreate, because a fresh session wouldn't fix a real fault. But that
// means every later message in the thread re-runs the turn, re-hits the same
// `failed` outcome, and would re-post the identical "session hit an error" line —
// the thread stuck on repeat forever (exactly the "ok bro is going to say it
// every time now" report). So we tell the user ONCE: the first failed delivery
// claims this key and posts the notice (with a link to open the session); every
// later one finds the claim already held and stays silent. Unlike the 5-minute
// inbound-message gate, the claim is long-lived so the quiet sticks — but it is
// NOT permanent: a month on, a lone message earns one fresh reminder. Reuses the
// same single-winner dedup table as `claimThreadCreate`, so no migration.
//
// Fail-CLOSED (suppress) on a DB hiccup — the entire purpose here is to NOT spam,
// so when the claim can't be resolved, stay quiet rather than risk re-posting.
const ERROR_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function threadErrorNoticeKey(teamId: string, threadId: string): string {
  return `slack:threaderror:${teamId}:${threadId}`;
}

export async function claimThreadErrorNotice(teamId: string, threadId: string): Promise<boolean> {
  if (!teamId || !threadId) return false;
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: threadErrorNoticeKey(teamId, threadId),
        expiresAt: new Date(Date.now() + ERROR_NOTICE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[slack-webhook] thread error-notice claim failed (suppressing notice)', err);
    return false;
  }
}

// Re-arm the notice when this thread is revived onto a genuinely NEW session (the
// `no-session` replace path), so that session's OWN first failure is surfaced
// instead of being swallowed by the prior session's still-held claim. Best-effort.
export async function clearThreadErrorNotice(teamId: string, threadId: string): Promise<void> {
  if (!teamId || !threadId) return;
  try {
    await db
      .delete(chatEventDedup)
      .where(eq(chatEventDedup.eventId, threadErrorNoticeKey(teamId, threadId)));
  } catch (err) {
    console.warn('[slack-webhook] thread error-notice clear failed', err);
  }
}
