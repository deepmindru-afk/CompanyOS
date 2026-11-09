import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

// `config` reads required env at module-load time, so set it before importing
// `./server` (same pattern as server.test.ts). The limit itself is passed to
// `buildServer`, so this test does not depend on module-load order.
process.env.KORTIX_API_URL = process.env.KORTIX_API_URL ?? 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? 'test-internal-token';

const { buildServer } = await import('./server');

// The fake API answers the gateway's one-call admission, and only that: an API
// in a different rollout answers 404 everywhere else. A bearer it knows comes
// back refused for billing WITH a principal, which is how the gateway learns
// the credential is real; an unknown one comes back refused as unauthenticated.
const apiCalls: string[] = [];
const realFetch = globalThis.fetch;
const refused = { ok: false, status: 401, errorCode: 'invalid_token', message: 'Invalid token' };
const billingRefused = {
  ok: false,
  status: 402,
  errorCode: 'subscription_required',
  principal: { accountId: 'acct', role: 'user' },
};
const fakeApi = (async (url: string, init: RequestInit) => {
  apiCalls.push(String(url));
  if (!String(url).endsWith('/admit')) return new Response('not found', { status: 404 });
  const { token } = JSON.parse(String(init.body)) as { token?: string };
  return Response.json({ admission: token === 'kortix_real' ? billingRefused : refused });
}) as typeof fetch;
// An API in the pre-`/admit` rollout: the gateway falls back to `/authorize`,
// which is the hook that must also validate a credential the API knows.
const fakeApiWithoutAdmit = (async (url: string, init: RequestInit) => {
  apiCalls.push(String(url));
  if (!String(url).endsWith('/authorize'))
    return Response.json({ error: 'not found' }, { status: 404 });
  const { token } = JSON.parse(String(init.body)) as { token?: string };
  return Response.json(token === 'kortix_real' ? billingRefused : refused);
}) as typeof fetch;
const useFakeApi = () => {
  apiCalls.length = 0;
  globalThis.fetch = fakeApi;
};
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

const call = (credential: string) =>
  new Request('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });

describe('per-credential limit on the gateway route (KRTX-4528)', () => {
  test('a flood of distinct never-validated credentials is refused once the shared allowance is spent', async () => {
    // 2/min is the setting the defect is about: a rotating fake bearer may
    // reach the API twice and must then be refused. On origin/dev each of the
    // five reaches the API under its own bucket.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({
      requestsPerMinutePerCredential: 1,
      requestsPerMinuteUnvalidated: 2,
    });
    const statuses: number[] = [];
    for (let n = 1; n <= 5; n++)
      statuses.push((await app.request(call(`kortix_fake_${n}`))).status);
    expect(statuses).toEqual([401, 401, 429, 429, 429]);
    // The two admitted requests are the two admission calls the fake API saw.
    expect(apiCalls).toHaveLength(2);
  });

  test('the shared allowance is its own setting, not one credential\u2019s budget', async () => {
    // A per-credential limit of 1 with the default shared setting must not
    // refuse real callers: ten credentials the API has never seen are each
    // admitted, where sharing the 1/min budget would refuse nine. The shared
    // bucket is a separate, far larger number (KRTX-4528: 600/min per
    // credential was never an unauthenticated-flood bound).
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({ requestsPerMinutePerCredential: 1 });
    const served: number[] = [];
    for (let n = 1; n <= 10; n++) served.push((await app.request(call(`kortix_new_${n}`))).status);
    expect(served).toEqual(Array<number>(10).fill(401));
  });

  test('fakes are refused once the shared allowance is spent, and a real credential keeps its own budget', async () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    // 3 shared slots: the fourth distinct fake is refused.
    const { app } = buildServer({
      requestsPerMinutePerCredential: 2,
      requestsPerMinuteUnvalidated: 3,
    });
    const fakes: number[] = [];
    for (let n = 1; n <= 6; n++) fakes.push((await app.request(call(`kortix_fake_${n}`))).status);
    expect(fakes).toEqual([401, 401, 401, 429, 429, 429]);
  });

  test('a credential the API answers with a principal gets its own budget back', async () => {
    // One pinned minute: a real clock would refill the budget.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({
      requestsPerMinutePerCredential: 2,
      requestsPerMinuteUnvalidated: 2,
    });
    // The first request reaches the fake API, which answers its principal. That
    // request took a shared slot, and validation gives it back once: the
    // credential's own budget of two admits two more, and the fourth is
    // refused. Without the refund the second request would still fit its own
    // budget but the shared bucket would be empty for the first fake below.
    expect((await app.request(call('kortix_real'))).status).toBe(402);
    expect((await app.request(call('kortix_real'))).status).toBe(402);
    expect((await app.request(call('kortix_real'))).status).toBe(402);
    expect((await app.request(call('kortix_real'))).status).toBe(429);
    // The refunded slot went back to the shared allowance: two fakes are still
    // admitted before it is spent again. Without the refund this first succeed
    // is refused, because the real credential's first request took the only
    // slot past the two it already spent.
    expect((await app.request(call('kortix_fake_1'))).status).toBe(401);
    expect((await app.request(call('kortix_fake_2'))).status).toBe(401);
    expect((await app.request(call('kortix_fake_3'))).status).toBe(429);
  });

  test('a flood of distinct never-validated x-api-key credentials is refused too', async () => {
    // The Anthropic path takes its credential from `x-api-key` and rewrites it
    // into a bearer BEFORE the pipeline runs, so a key must be validated by the
    // API's answer, never by the route that carried it: these five fakes never
    // reach a principal, so they all stay on the one shared bucket and the
    // third is refused. A route that marked its own key validated would hand
    // each fake a private bucket and admit all five.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({
      requestsPerMinutePerCredential: 1,
      requestsPerMinuteUnvalidated: 2,
    });
    const statuses: number[] = [];
    for (let n = 1; n <= 5; n++)
      statuses.push(
        (
          await app.request(
            new Request('https://gateway.test/v1/messages', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': `kortix_xkey_${n}` },
              body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [] }),
            }),
          )
        ).status,
      );
    expect(statuses).toEqual([401, 401, 429, 429, 429]);
    expect(apiCalls).toHaveLength(2);
  });

  test('the authorize hook validates a credential too, not only admit', async () => {
    // An API without `/admit` answers `/authorize`, which carries the principal
    // as well. Without the authorize wrapper the real credential would stay on
    // the shared bucket, so its second request would be refused by the shared
    // limit instead of its own budget — the same status, so assert the bucket
    // the second request drew from via the fake that follows: a fake must still
    // be admitted, which a shared charge would refuse at limit 1.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    globalThis.fetch = fakeApiWithoutAdmit;
    const { app } = buildServer({
      requestsPerMinutePerCredential: 1,
      requestsPerMinuteUnvalidated: 1,
    });
    expect((await app.request(call('kortix_real'))).status).toBe(402);
    // Its shared slot was refunded: a fake still fits the shared allowance.
    expect((await app.request(call('kortix_fake_1'))).status).toBe(401);
  });

  test('a whitespace-bearing bearer is charged at the route too, not passed uncounted', async () => {
    // `Bearer fake one` carries internal whitespace: the pipeline's bearer
    // grammar (`/^(B|\S.*)$/` — see create-gateway.ts) accepts it and calls the
    // API, so the limiter must count it as well, else the flood reopens.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({
      requestsPerMinutePerCredential: 1,
      requestsPerMinuteUnvalidated: 1,
    });
    const spaced = (n: string) =>
      new Request('https://gateway.test/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer fake ${n}` },
        body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [] }),
      });
    expect((await app.request(spaced('one'))).status).toBe(401);
    expect((await app.request(spaced('two'))).status).toBe(429);
    // The second request was refused by the limiter, before any API round trip.
    expect(apiCalls).toHaveLength(1);
  });

  test('one source cannot pin the shared allowance: the per-source allowance is far below it', async () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    useFakeApi();
    const { app } = buildServer({
      requestsPerMinutePerCredential: 1,
      requestsPerMinuteUnvalidated: 200,
    });
    const from = (ip: string, n: number) =>
      new Request('https://gateway.test/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer kortix_fake_${n}`,
          'cf-connecting-ip': ip,
        },
        body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [] }),
      });
    // One source may spend 1% of the 200-per-minute shared allowance: two
    // admissions, then a refusal WHILE the shared allowance still holds 198.
    const fromSource = (ip: string, n: number) =>
      app.request(from(ip, n), undefined, { clientIp: ip });
    expect((await fromSource('1.2.3.4', 1)).status).toBe(401);
    expect((await fromSource('1.2.3.4', 2)).status).toBe(401);
    expect((await fromSource('1.2.3.4', 3)).status).toBe(429);
    // A different source admits on the same shared allowance.
    expect((await fromSource('5.6.7.8', 4)).status).toBe(401);
  });

  test('the /health probe draws from the same allowance when it forwards a caller bearer', async () => {
    // The probe reads a caller bearer and calls `/authenticate` with it: the
    // same unbounded-per-credential work the model routes guard. The shared
    // allowance is 2, so at most the FIRST two probe credentials reach it —
    // counted as distinct tokens asked, independent of the client's retries.
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const realFetch = globalThis.fetch;
    const askedTokens = new Set<string>();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/authenticate')) {
        const { token } = JSON.parse(String(init?.body)) as { token?: string };
        askedTokens.add(token ?? '');
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      const { app } = buildServer({
        requestsPerMinutePerCredential: 1,
        requestsPerMinuteUnvalidated: 2,
      });
      for (let n = 1; n <= 5; n++) {
        const res = await app.request(
          new Request('https://gateway.test/health', {
            headers: { authorization: `Bearer kortix_fake_${n}` },
          }),
        );
        // Probes 3-5 are refused by the allowance: 503 is the honest probe
        // answer for the first two (the fake API is down), 429 the refusal.
        if (n > 2) expect(res.status).toBe(429);
      }
      expect(askedTokens.size).toBeLessThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
