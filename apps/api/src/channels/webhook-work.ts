/**
 * Inbound Slack and Teams webhooks: claim, ack, work. Telegram and Email store
 * each event before the ack instead (integrations/event-inbox.ts).
 *
 * A webhook handler claims its event in `chat_event_dedup` so a provider retry
 * does not run it twice, then acks 200 and works on. If the work fails, the
 * claim must not outlive it: the provider's retry (Slack) would find
 * the claim held and drop the event. This module records every claim a handler
 * takes, in an async scope, and releases them all when the work fails.
 *
 * The ack waits up to `ACK_WAIT_MS` for the work. A fast failure answers 500, so
 * the provider retries; slow work answers 200 and finishes in the background.
 * Either way the work is registered with the shutdown drain (`shared/drain.ts`),
 * so a deploy waits for it instead of cutting it.
 *
 * Slow work is loud: when the ack budget elapses the log names the work's
 * stage split (`dbMs`, `httpMs`) so a p95 rise on a webhook route attributes
 * to DB stalls, outbound (Slack) latency, or handler compute without tracing
 * (KRTX-4015: with no line here a >2s work was invisible — the request log
 * shows only "2002ms").
 *
 * Not covered: a crash (OOM, SIGKILL) while the work runs. The claim then holds
 * until it expires, and the event is lost.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { inArray } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { trackDetached } from '../shared/drain';
import { stageSnapshot } from '../lib/server-timing';

/** Slack drops a webhook that has not answered after 3 s; stay well under it. */
export const ACK_WAIT_MS = 2_000;

/**
 * Event-callback ack budget. The event routes' 200 body is `{ok: true}` — Slack
 * reads nothing out of it, so holding the request for work costs only latency:
 * with `ACK_WAIT_MS` (2026-11-03..05 prod p95 rows on `POST /v1/webhooks/slack`
 * all pinned ~2002-2157 ms on this budget while the work — db statements, git
 * mirrors, Slack posts — ran behind it). 250 ms keeps the quick-failure 500
 * window (Slack retries a 5xx) while capping every event-callback response at
 * ~250 ms — always inside the 438 ms p95 acceptance (1.5 x the 292 ms baseline,
 * `infra:log:0e6410423224`) even with the ~150 ms post-budget jitter the pinned
 * rows also showed. The Teams webhooks ack at 0 (`ackWaitMs: 0` in
 * `channels/teams/routes.ts`) for the same reason; the interactivity routes keep
 * `ACK_WAIT_MS` because their 200 body is read (`response_action`,
 * close-modal).
 */
export const EVENT_ACK_WAIT_MS = 250;

const claimScope = new AsyncLocalStorage<Set<string>>();

/** Call after a claim insert wins. A no-op outside `runWebhookWork`. */
export function recordClaim(eventId: string): void {
  claimScope.getStore()?.add(eventId);
}

async function releaseClaims(keys: ReadonlySet<string>): Promise<void> {
  if (keys.size === 0) return;
  try {
    await db.delete(chatEventDedup).where(inArray(chatEventDedup.eventId, [...keys]));
  } catch (error) {
    logger.error('[webhook-work] claim release failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

export type WebhookOutcome = 'done' | 'pending' | 'failed';

/** Where the work's time went so far: db vs outbound http (incl. GoTrue). */
function stageFields(): Record<string, number> {
  const stages = stageSnapshot();
  const db = stages.db;
  const outbound = (stages.http?.wallMs ?? 0) + (stages.gotrue?.wallMs ?? 0);
  return {
    dbMs: Math.round(db?.wallMs ?? 0),
    dbOps: db?.count ?? 0,
    httpMs: Math.round(outbound),
    httpOps: (stages.http?.count ?? 0) + (stages.gotrue?.count ?? 0),
  };
}

export async function runWebhookWork(
  label: string,
  work: () => Promise<void>,
  options: { ackWaitMs?: number; releaseOnFailure?: boolean } = {},
): Promise<WebhookOutcome> {
  const ackWaitMs = options.ackWaitMs ?? ACK_WAIT_MS;
  const startedAt = Date.now();
  const claims = new Set<string>();
  let outcome: WebhookOutcome = 'pending';
  // True only when the ack timer actually won the race: the ack went out at the
  // budget and the work outlived the response. Work that merely ran long while
  // blocking the loop still won the race, its duration is in the request log.
  let ackTimedOut = false;
  const running = claimScope.run(claims, work).then(
    () => {
      outcome = 'done';
      if (ackTimedOut) {
        logger.warn('[webhook-work] work finished after the ack', {
          label,
          workMs: Date.now() - startedAt,
          ackWaitMs,
          ...stageFields(),
        });
      }
    },
    async (error) => {
      outcome = 'failed';
      logger.error(`[${label}] handler failed`, {
        error: error instanceof Error ? error.message : String(error),
        workMs: Date.now() - startedAt,
        ...stageFields(),
      });
      if (options.releaseOnFailure !== false) await releaseClaims(claims);
    },
  );
  trackDetached(running);
  if (ackWaitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ackWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // Still 'pending' here means the timer won: the provider got its ack and
    // the work outlived it (request logs pin at the budget and say no more).
    if (outcome === 'pending') {
      ackTimedOut = true;
      logger.warn('[webhook-work] ack budget elapsed — work still running', {
        label,
        ackWaitMs,
        ...stageFields(),
      });
    }
  }
  return outcome;
}
