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
 * Not covered: a crash (OOM, SIGKILL) while the work runs. The claim then holds
 * until it expires, and the event is lost.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { inArray } from 'drizzle-orm';
import { chatEventDedup } from '@kortix/db';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { trackDetached } from '../shared/drain';

/** Slack drops a webhook that has not answered after 3 s; stay well under it. */
export const ACK_WAIT_MS = 2_000;

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

export async function runWebhookWork(
  label: string,
  work: () => Promise<void>,
  options: { ackWaitMs?: number; releaseOnFailure?: boolean } = {},
): Promise<WebhookOutcome> {
  const ackWaitMs = options.ackWaitMs ?? ACK_WAIT_MS;
  const startedAt = Date.now();
  const claims = new Set<string>();
  let outcome: WebhookOutcome = 'pending';
  const running = claimScope.run(claims, work).then(
    () => {
      outcome = 'done';
      // The request answered at the ack budget; how much slower the work ran is
      // the only record of WHY a webhook's p95 rose (KRTX-4015). >= : finishing
      // at the budget means the budget did not cover it.
      const workMs = Date.now() - startedAt;
      if (ackWaitMs > 0 && workMs >= ackWaitMs) {
        logger.warn('[webhook-work] work finished after the ack', { label, workMs, ackWaitMs });
      }
    },
    async (error) => {
      outcome = 'failed';
      logger.error(`[${label}] handler failed`, {
        error: error instanceof Error ? error.message : String(error),
        workMs: Date.now() - startedAt,
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
      logger.warn('[webhook-work] ack budget elapsed — work still running', { label, ackWaitMs });
    }
  }
  return outcome;
}
