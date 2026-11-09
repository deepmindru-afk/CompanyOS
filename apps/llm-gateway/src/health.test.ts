import { describe, expect, setSystemTime, test } from 'bun:test';
import { InflightBudget } from '@kortix/llm-gateway';
import { Hono } from 'hono';
import { createApiClient } from './clients/api-client';
import { registerHealth } from './health';
import { createTokenRateLimit } from './token-rate-limit';

// The same date for every test in the suite keeps the limiter's windows apart.
setSystemTime(new Date('2026-11-02T12:00:00Z'));

function health(
  options: {
    down?: boolean;
    degraded?: boolean;
    authDown?: boolean;
    upstream?: { incidents: string[]; warnings: string[] };
    rateLimit?: ReturnType<typeof createTokenRateLimit>;
  } = {},
) {
  const api = createApiClient({
    baseUrl: 'http://api.test',
    token: 'synthetic-internal-token',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/internal/gateway/authenticate')) {
        if (options.authDown) return Response.json({}, { status: 401 });
        const body = JSON.parse(String(init.body));
        return Response.json({
          principal:
            body.token === 'synthetic-valid-token'
              ? { userId: 'synthetic-user', accountId: 'synthetic-account' }
              : null,
        });
      }
      return Response.json({}, { status: options.down ? 503 : 200 });
    },
  });
  // Every disclosure test stays far under the probe allowance; the limiter is
  // wired because `/health` forwards a caller bearer to `authenticate`, the
  // same allowance the model routes draw from.
  const app = new Hono<{ Bindings: { clientIp?: string | null } }>();
  const rateLimit = options.rateLimit ?? createTokenRateLimit(600, 10_000);
  registerHealth(
    app,
    api,
    new InflightBudget({ maxBytes: 1024, perRequestMaxBytes: 1024 }),
    null,
    () => ({
      window_s: 300,
      requests: 20,
      errors: options.degraded ? 20 : 0,
      error_rate: options.degraded ? 1 : 0,
    }),
    () => options.upstream ?? { incidents: [], warnings: [] },
    rateLimit,
  );
  return app;
}

describe('gateway health disclosure boundary', () => {
  for (const authorization of [undefined, 'Basic synthetic', 'Bearer invalid', 'Bearer']) {
    test(`returns only status without valid gateway authentication (${authorization ?? 'anonymous'})`, async () => {
      const response = await health().request('/health', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'healthy' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  }
  test('keeps readiness status and HTTP 503 when the API is down', async () => {
    const response = await health({ down: true }).request('/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
  });
  test('keeps degraded status without disclosing traffic', async () => {
    const response = await health({ degraded: true }).request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'degraded' });
  });
  test('upstream capacity the fallbacks absorb stays healthy; failures after every fallback are degraded', async () => {
    const warnings = [
      'upstream capacity: glm-5.3-flash 50% of 40 requests met an upstream failure (429x20) over 300s',
    ];
    const absorbed = health({ upstream: { incidents: [], warnings } });
    expect(await (await absorbed.request('/health')).json()).toEqual({ status: 'healthy' });
    const detailed = await (
      await absorbed.request('/health', {
        headers: { authorization: 'Bearer synthetic-valid-token' },
      })
    ).json();
    expect(detailed.incidents).toEqual([]);
    expect(detailed.warnings).toEqual(warnings);
    const failing = health({
      upstream: {
        incidents: [
          'upstream failure: glm-5.3-flash 25% of 40 requests failed after every fallback over 300s',
        ],
        warnings,
      },
    });
    expect(await (await failing.request('/health')).json()).toEqual({ status: 'degraded' });
  });
  test('valid gateway credentials retain the detailed checks', async () => {
    const response = await health().request('/health', {
      headers: { authorization: 'bEaReR synthetic-valid-token' },
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('commit');
    expect(body.checks.api.status).toBe('up');
    expect(body.checks.admission.capacity_bytes).toBe(1024);
    expect(body.traffic.requests).toBe(20);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  test('a bearer the API proves real refunds its shared allowance slot', async () => {
    // The probe spends shared allowance on the pre-validation admission. A
    // credential the API answers with a principal must give that slot back,
    // exactly as the model routes do — otherwise one real probe drains the
    // unvalidated allowance for every made-up bearer until the window resets.
    // At a shared allowance of 2 the real probe plus TWO distinct fakes fit; a
    // third is refused, so the test proves both the refund and the bound.
    const rateLimit = createTokenRateLimit(1, 2);
    const app = health({ rateLimit });
    const probe = (token: string) =>
      app.request('/health', { headers: { authorization: `Bearer ${token}` } });
    expect((await probe('synthetic-valid-token')).status).toBe(200);
    expect((await probe('synthetic-fake-1')).status).toBe(200);
    expect((await probe('synthetic-fake-2')).status).toBe(200);
    expect((await probe('synthetic-fake-3')).status).toBe(429);
  });
  test('authentication failure never discloses details', async () => {
    const response = await health({ authDown: true }).request('/health', {
      headers: { authorization: 'Bearer synthetic-valid-token' },
    });
    expect(await response.json()).toEqual({ status: 'healthy' });
  });
});
