import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTokenRateLimit } from './token-rate-limit';

const request = (path: string, headers: Record<string, string>) =>
  new Request(`https://gateway.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"model":"x","messages":[]}',
  });

afterEach(() => setSystemTime());

describe('per-credential request limit', () => {
  test('refuses the request over the limit with 429 and Retry-After, and the next minute admits it again', async () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    limit.validated('kortix_sb_a');
    const call = () =>
      limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_a' }));
    expect(call()).toBeNull();
    expect(call()).toBeNull();
    const refused = call();
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('30');
    const body = (await refused?.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');

    setSystemTime(new Date('2026-11-02T12:00:30Z'));
    expect(call()).toBeNull();
  });

  test('counts each validated credential apart, and x-api-key is a credential', () => {
    const limit = createTokenRateLimit(1);
    for (const credential of ['kortix_sb_a', 'kortix_sb_b', 'kortix_gw_c'])
      limit.validated(credential);
    const call = (credential: string) =>
      limit(request('/v1/chat/completions', { authorization: `Bearer ${credential}` }));
    expect(call('kortix_sb_a')).toBeNull();
    expect(call('kortix_sb_a')?.status).toBe(429);
    expect(call('kortix_sb_b')).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))?.status).toBe(429);
  });

  test('does not count a request without a credential: the pipeline refuses it with 401 and no API call', () => {
    const limit = createTokenRateLimit(1);
    for (let i = 0; i < 5; i++) expect(limit(request('/v1/chat/completions', {}))).toBeNull();
  });

  test('answers Messages and Claude Code requests in the Anthropic envelope', async () => {
    const limit = createTokenRateLimit(1);
    for (const path of ['/v1/messages', '/v1/claude-code/v1/messages']) {
      const headers = { authorization: `Bearer kortix_sb_${path.length}` };
      limit.validated(`kortix_sb_${path.length}`);
      limit(request(path, headers));
      const refused = limit(request(path, headers));
      expect(refused?.status).toBe(429);
      expect(await refused?.json()).toEqual({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Too many requests for this credential. Retry shortly.',
        },
      });
    }
  });
});

describe('credentials the gateway has not validated (KRTX-4528)', () => {
  const fake = (n: number) =>
    request('/v1/chat/completions', { authorization: `Bearer kortix_fake_${n}` });

  test('refuses a flood of never-validated credentials once the shared allowance is spent', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    // A third unseen credential is refused: a fresh fake cannot buy a bucket.
    const refused = limit(fake(3));
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('30');
    // Repeating a fake already admitted does not buy anything either.
    expect(limit(fake(1))?.status).toBe(429);
  });

  test('a flood of never-validated credentials leaves only the one shared bucket', () => {
    const limit = createTokenRateLimit(5);
    for (let i = 0; i < 200; i++) limit(fake(i));
    expect(limit.buckets()).toEqual(['gateway_token:distinct_credentials']);
  });

  test('refunds a credential’s shared slot once, however often it is validated', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    // A request authenticates the same token several times per call (authorize,
    // admit); a second validated() must not refund a slot it never took.
    limit.validated('kortix_fake_1');
    limit.validated('kortix_fake_1');
    expect(limit(fake(3))).toBeNull();
    expect(limit(fake(4))?.status).toBe(429);
  });

  test('validating a credential moves it off the shared bucket and refunds its slot', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    // Two fakes take the two shared slots, so the allowance is empty.
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    expect(limit(fake(9))?.status).toBe(429);
    // The API answered `kortix_fake_1` with a principal: its shared slot is
    // refunded, so exactly one more unvalidated request fits.
    limit.validated('kortix_fake_1');
    expect(limit(fake(8))).toBeNull();
    expect(limit(fake(7))?.status).toBe(429);
    // It also has its own budget now, so repeating it is not the shared limit.
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(1))?.status).toBe(429);
  });

  test('a whitespace-bearing bearer is counted like the pipeline counts it', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1);
    // The pipeline's bearer grammar accepts internal whitespace
    // (`/^Bearer\s+(\S.*)$/i` in create-gateway.ts), so the limiter must count
    // it too: the first such credential is admitted, the second is refused.
    expect(limit(request('/v1/chat/completions', { authorization: 'Bearer fake one' }))).toBeNull();
    expect(
      limit(request('/v1/chat/completions', { authorization: 'Bearer fake two' }))?.status,
    ).toBe(429);
  });

  test('the charged-shared set is capped: a flood cannot grow it without bound', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000);
    for (let i = 0; i < 50_001; i++) limit(fake(i));
    expect(limit.chargedCount()).toBe(50_000);
  });

  test('a flood of rotating source addresses never resets the shared allowance', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000, 10);
    // 50 001 distinct sources: in a shared map this evicts the shared bucket
    // (created first) and re-creates it full, renewing the flood bound forever.
    let admitted = 0;
    for (let i = 0; i < 50_001; i++) {
      const r = new Request('https://gateway.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer kortix_fake_${i}`,
          'cf-connecting-ip': `10.0.${Math.floor(i / 256) % 256}.${i % 256}`,
        },
        body: '{"model":"x","messages":[]}',
      });
      if (limit(r, new Headers(), `10.0.${Math.floor(i / 256) % 256}.${i % 256}`) === null)
        admitted++;
    }
    // The shared allowance is 10/min; a reset would admit far more.
    expect(admitted).toBeLessThanOrEqual(12);
  });

  test('turning the edge trust off skips the per-source share: the shared allowance alone applies', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000, 10, { trustEdgeClientIp: false });
    let admitted = 0;
    for (let i = 0; i < 20; i++)
      admitted += limit(fake(i), new Headers(), '10.0.0.1') === null ? 1 : 0;
    // One source at 1% of a 10-per-minute allowance would admit 1; with the
    // share skipped, the shared 10 apply.
    expect(admitted).toBe(10);
  });
});
