import { ProjectSnapshotError } from './errors'

/** The S3 retry policy both transfer loops share (stage.ts, hydrate.ts). */

/**
 * Backoff before retrying `attempt` (the attempt that just failed, 1-based):
 * `baseMs * 2 ** (attempt - 1)` plus 0–249 ms of jitter, clamped to the
 * milliseconds left before `deadline` (a `Date.now()` basis) when one is set.
 */
export function snapshotBackoff(attempt: number, baseMs: number, deadline?: number): number {
  const backoff = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
  if (deadline === undefined) return backoff
  return Math.min(backoff, Math.max(0, deadline - Date.now()))
}

/** Only the classified-transient reasons (`S3_RETRYABLE_REASONS`) retry. */
export function retryable(failure: ProjectSnapshotError): boolean {
  return failure.retryable
}
