import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { TokenBucketRateLimiter } from './rate-limit';

afterEach(() => setSystemTime());

describe('TokenBucketRateLimiter.refund', () => {
  test('returns one token to a spent bucket without refilling it past its limit', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limiter = new TokenBucketRateLimiter('t');
    const policy = { limit: 1, windowMs: 60_000 };
    expect(limiter.check('k', policy).allowed).toBe(true);
    expect(limiter.check('k', policy).allowed).toBe(false);
    // Refunding a token a real credential's request should not have spent
    // admits the next request.
    limiter.refund('k', policy);
    expect(limiter.check('k', policy).allowed).toBe(true);
    // A refund never grows a bucket past its limit: a spent-then-refunded
    // limit-2 bucket admits two, not three.
    const two = new TokenBucketRateLimiter('cap');
    const twoPolicy = { limit: 2, windowMs: 60_000 };
    expect(two.check('k', twoPolicy).allowed).toBe(true);
    two.refund('k', twoPolicy);
    two.refund('k', twoPolicy);
    expect(two.check('k', twoPolicy).allowed).toBe(true);
    expect(two.check('k', twoPolicy).allowed).toBe(true);
    expect(two.check('k', twoPolicy).allowed).toBe(false);
  });

  test('takes the cap from the policy the caller passes', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limiter = new TokenBucketRateLimiter('t');
    const policy = { limit: 1, windowMs: 60_000 };
    expect(limiter.check('k', policy).allowed).toBe(true);
    limiter.refund('k', policy);
    limiter.refund('k', policy);
    // The bucket is full at 1: two refunds never bank a second token.
    expect(limiter.check('k', policy).allowed).toBe(true);
    expect(limiter.check('k', policy).allowed).toBe(false);
  });

  test('refunds only the named bucket, and silently ignores an unknown key', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limiter = new TokenBucketRateLimiter('t');
    const policy = { limit: 1, windowMs: 60_000 };
    limiter.check('a', policy);
    limiter.check('b', policy);
    limiter.refund('a', policy);
    limiter.refund('never-seen', policy);
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('b', policy).allowed).toBe(false);
  });
});

describe('TokenBucketRateLimiter.keys', () => {
  test('lists the live bucket keys with the namespace prefix', () => {
    const limiter = new TokenBucketRateLimiter('gw');
    limiter.check('x', { limit: 1, windowMs: 60_000 });
    expect(limiter.keys()).toEqual(['gw:x']);
  });
});
