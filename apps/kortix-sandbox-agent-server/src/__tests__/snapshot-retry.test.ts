import { describe, expect, test } from 'bun:test'
import { ProjectSnapshotError } from '@/lib/project-snapshot/errors'
import { retryable, snapshotBackoff } from '@/lib/project-snapshot/retry'

// Pins the shared S3 retry policy (lib/project-snapshot/retry.ts) to the
// values the two transfer loops shipped with: stage backoff base 300 ms,
// hydrate base 500 ms, jitter 0–249 ms, deadline clamp.
describe('snapshotBackoff', () => {
  test('grows exponentially with the attempt, jitter bounded to 0–249 ms', () => {
    for (const baseMs of [300, 500]) {
      for (const attempt of [1, 2, 3]) {
        const floor = baseMs * 2 ** (attempt - 1)
        const ceiling = floor + 249
        for (let i = 0; i < 200; i++) {
          const backoff = snapshotBackoff(attempt, baseMs)
          expect(backoff).toBeGreaterThanOrEqual(floor)
          expect(backoff).toBeLessThanOrEqual(ceiling)
        }
      }
    }
  })

  test('the jitter varies', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(snapshotBackoff(1, 300))
    expect(seen.size).toBeGreaterThan(10)
  })

  test('clamps to the deadline and never waits past it', () => {
    const past = Date.now() - 1
    expect(snapshotBackoff(3, 500, past)).toBe(0)
    const soon = Date.now() + 100
    for (let i = 0; i < 50; i++) {
      const backoff = snapshotBackoff(3, 500, soon)
      expect(backoff).toBeGreaterThanOrEqual(0)
      expect(backoff).toBeLessThanOrEqual(100)
    }
    // A far deadline leaves the curve untouched.
    const far = Date.now() + 60_000
    const backoff = snapshotBackoff(1, 300, far)
    expect(backoff).toBeGreaterThanOrEqual(300)
    expect(backoff).toBeLessThanOrEqual(549)
  })
})

describe('retryable', () => {
  test('true only for the classified-transient reasons', () => {
    expect(retryable(new ProjectSnapshotError('download', 'unavailable', 'x'))).toBe(true)
    expect(retryable(new ProjectSnapshotError('download', 'timeout', 'x'))).toBe(true)
    expect(retryable(new ProjectSnapshotError('download', 'denied', 'x'))).toBe(false)
    expect(retryable(new ProjectSnapshotError('hydrate', 'cancelled', 'x'))).toBe(false)
    expect(retryable(new ProjectSnapshotError('descriptor', 'expired-authorization', 'x'))).toBe(false)
    expect(retryable(new ProjectSnapshotError('extract', 'digest-mismatch', 'x'))).toBe(false)
  })
})
