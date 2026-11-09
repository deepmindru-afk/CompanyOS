import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// The share edges read the share row from the database. These suites assert
// routing and response policy, so the read answers "no such token" without a
// network.
mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
}));

const { PUBLIC_SHARE_SANDBOX_CSP, publicShareApp, previewNavigationRedirect, publicResponseHeaders } =
  await import('./public-share');

describe('public-share path form response headers', () => {
  test('drops every upstream Set-Cookie, with or without a Domain attribute', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'session=author; Domain=example.com; Path=/');
    upstream.append('set-cookie', 'plain=1; Path=/');
    upstream.set('content-type', 'text/html');
    const headers = publicResponseHeaders(upstream, '');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.getSetCookie()).toEqual([]);
    expect(headers.get('content-type')).toBe('text/html');
  });

  test('runs author content in an opaque origin and keeps the author policy', () => {
    const upstream = new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" });
    const headers = publicResponseHeaders(upstream, '');
    const policies = headers.get('content-security-policy') ?? '';
    expect(policies).toContain("default-src 'self'");
    expect(policies).not.toContain('frame-ancestors');
    expect(policies).toContain(PUBLIC_SHARE_SANDBOX_CSP);
    expect(PUBLIC_SHARE_SANDBOX_CSP.startsWith('sandbox ')).toBe(true);
    expect(PUBLIC_SHARE_SANDBOX_CSP).not.toContain('allow-same-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('adds the sandbox policy when upstream sends none', () => {
    const headers = publicResponseHeaders(new Headers(), 'https://viewer.example');
    expect(headers.get('content-security-policy')).toBe(PUBLIC_SHARE_SANDBOX_CSP);
    expect(headers.get('access-control-allow-credentials')).toBe('false');
  });
});

describe('public-share path form navigation redirect', () => {
  const base = {
    method: 'GET',
    fetchDest: 'document',
    previewOrigin: 'https://dev-p3000-abc.preview.example',
    path: '/docs',
    search: '?q=1',
    token: 'kps_token',
  };

  test('a document navigation goes to the preview origin with the share token', () => {
    expect(previewNavigationRedirect(base)).toBe(
      'https://dev-p3000-abc.preview.example/docs?q=1&public_share=kps_token',
    );
    expect(previewNavigationRedirect({ ...base, fetchDest: 'iframe', search: '' })).toBe(
      'https://dev-p3000-abc.preview.example/docs?public_share=kps_token',
    );
  });

  test('programmatic requests, writes, and deployments without a preview domain stay on the path form', () => {
    expect(previewNavigationRedirect({ ...base, fetchDest: 'empty' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, fetchDest: undefined })).toBeNull();
    expect(previewNavigationRedirect({ ...base, method: 'POST' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, previewOrigin: null })).toBeNull();
  });
});

/**
 * A client that builds a share URL of its own drops the trailing slash the API
 * advertises (`/…/<token>/<port>`, no `/`). Hono's non-strict match serves that
 * bare form from the `/:token/:port/*` edge, the same edge that serves
 * `/…/<token>/<port>/`, so both forms reach the token gate and the share opens.
 *
 * No canonicalising redirect sits in front of it. The `/:token/:port` route that
 * once did was unreachable — Hono matches the wildcard first — and pointed at
 * `/…/<port>/?<query>`, a `?` glued to a `/`. It is deleted rather than fixed.
 *
 * The mount below mirrors production's order (app.ts `app.route('/v1/p', …)`,
 * then sandbox-proxy/index.ts: the share sub-app, then the authenticated
 * `/:sandboxId/:port/*` proxy). A fall-through names the proxy's sandbox
 * `public-share`, so it is visible as such instead of as a bare status.
 */
describe('public-share port root without a trailing slash', () => {
  const app = new Hono();
  app.route('/v1/p/public-share', publicShareApp);
  app.all('/v1/p/:sandboxId/:port/*', (c) => c.json({ sandbox: c.req.param('sandboxId') }, 401));
  app.all('/v1/p/:sandboxId/:port', (c) => c.json({ sandbox: c.req.param('sandboxId') }, 401));

  async function get(path: string) {
    const res = await app.request(`http://api.test${path}`, { redirect: 'manual' });
    const body = (await res.clone().json().catch(() => null)) as { sandbox?: string; error?: string } | null;
    return { status: res.status, location: res.headers.get('location'), body };
  }

  const TOKEN = 'kps_11111111111141118111111111111111';

  for (const [label, search] of [
    ['', ''],
    [' with a query', `?public_share=${TOKEN}`],
  ] as const) {
    test(`reaches the share token gate, not the authenticated proxy${label}`, async () => {
      const res = await get(`/v1/p/public-share/${TOKEN}/3000${search}`);
      // The token gate's answer for a token no row carries. 404 here is the
      // share edge answering, not a fall-through: the proxy would name itself.
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Share link not found' });
      expect(res.body).not.toHaveProperty('sandbox');
      // No redirect hop: the bare form is served, it is not canonicalised away.
      expect(res.location).toBeNull();
    });
  }

  // The defect this issue filed: `/:token/:port` was registered after
  // `/:token/:port/*`, and Hono matches the wildcard for the bare path too, so
  // that handler could never answer — a dead route carrying a broken Location.
  // A pattern is shadowed when an earlier-registered pattern already covers
  // every path it can match; this asserts no route is left in that state.
  test('no registered share route is shadowed by an earlier one', async () => {
    // `/a/*` answers every path under `/a/`, and `/a` itself under Hono's
    // non-strict match, so it covers any later pattern starting with `/a/`.
    const covered = (earlier: string, later: string) => {
      if (!earlier.endsWith('/*')) return false;
      const prefix = earlier.slice(0, -1);
      return later.startsWith(prefix) || later === prefix.slice(0, -1);
    };
    const routes = publicShareApp.routes;
    for (let i = 0; i < routes.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(
          covered(routes[j].path, routes[i].path),
          `${routes[i].method} ${routes[i].path} is shadowed by ${routes[j].method} ${routes[j].path}`,
        ).toBe(false);
      }
    }
  });

  test('serves the trailing-slash form identically', async () => {
    const bare = await get(`/v1/p/public-share/${TOKEN}/3000`);
    const slashed = await get(`/v1/p/public-share/${TOKEN}/3000/`);
    expect(slashed).toEqual(bare);
  });
});
