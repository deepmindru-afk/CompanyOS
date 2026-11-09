/**
 * The `/call` response contract, beside the legacy fields:
 *   - every ok and error body names its `binding` and the `upstream_status`;
 *   - an ok body carries `output`, the payload without the binding's envelope,
 *     and `upstream_error` when the upstream reported a failure inside a 2xx
 *     (MCP `isError` / JSON-RPC error, GraphQL `errors` with no data);
 *   - an upstream 429 or 503 keeps its status, with `Retry-After`;
 *   - the upstream deadline answers `upstream_timeout` before any client gives up.
 * Fake deps, no database.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type GatewayAction,
  type GatewayConnector,
  type GatewayDeps,
  callOutput,
  handleCall,
} from '../connectors/gateway';
import {
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
  connectorErrorHttpStatus,
  createConnectorRouter,
} from '../connectors/router';
import type { ActionBinding } from '../connectors/types';

const CONNECTOR: GatewayConnector = {
  connectorId: 'conn-crm',
  slug: 'crm',
  provider: 'openapi',
  baseUrl: 'https://crm.example.test',
  auth: { type: 'none', in: 'header', name: null, prefix: null },
  hasAuth: false,
  credentialMode: 'shared',
  enabled: true,
};

function action(binding: ActionBinding): GatewayAction {
  return { path: 'crm.contacts.list', relPath: 'contacts.list', inputSchema: {}, risk: 'read', binding };
}

const OPENAPI = action({ kind: 'openapi', method: 'GET', path: '/contacts', server: 'https://crm.example.test' });

type Respond = (init: { signal?: AbortSignal }) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

function gatewayDeps(respond: Respond, overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    loadConnectorBySlug: async () => CONNECTOR,
    loadAction: async () => OPENAPI,
    resolveCredential: async () => null,
    loadPolicies: async () => [],
    loadProjectPolicies: async () => [],
    loadDefaultMode: async () => 'allow_all',
    recordExecution: async () => null,
    fetchImpl: async (_url, init) => {
      const r = await respond(init);
      const headers = new Headers(r.headers ?? {});
      return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body, headers };
    },
    ...overrides,
  } as GatewayDeps;
}

const INPUT = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  subject: { userId: 'user-1', groupIds: [] },
  sessionId: null,
  connectorSlug: 'crm',
  actionPath: 'contacts.list',
  args: {},
};

describe('callOutput()', () => {
  test('composio: the result without the Composio envelope', () => {
    const data = { provider: 'composio', requestId: 'log-1', logId: 'log-1', sessionId: 's', result: { messages: [1] } };
    expect(callOutput('composio', data)).toEqual({ output: { messages: [1] } });
  });

  test('mcp: structuredContent first, then content', () => {
    const structured = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { n: 2 } } };
    expect(callOutput('mcp', structured)).toEqual({ output: { n: 2 } });
    const content = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } };
    expect(callOutput('mcp', content)).toEqual({ output: [{ type: 'text', text: 'hi' }] });
  });

  test('mcp: isError names the tool text as upstream_error', () => {
    const data = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'no such issue' }] } };
    expect(callOutput('mcp', data)).toEqual({
      output: [{ type: 'text', text: 'no such issue' }],
      upstreamError: 'no such issue',
    });
  });

  test('mcp: a JSON-RPC error is an upstream_error with the secret redacted', () => {
    const data = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad token tok_secret' } };
    expect(callOutput('mcp', data, 'tok_secret')).toEqual({
      output: null,
      upstreamError: 'JSON-RPC -32602 bad token [REDACTED]',
    });
  });

  test('graphql: data.data; errors with no data → upstream_error; partial data stays clean', () => {
    expect(callOutput('graphql', { data: { issue: { id: 'i1' } } })).toEqual({ output: { issue: { id: 'i1' } } });
    expect(callOutput('graphql', { data: { issue: null }, errors: [{ message: 'Entity not found' }] })).toEqual({
      output: { issue: null },
      upstreamError: 'Entity not found',
    });
    expect(callOutput('graphql', { errors: [{ message: 'Syntax error' }] })).toEqual({
      output: null,
      upstreamError: 'Syntax error',
    });
    expect(callOutput('graphql', { data: { a: 1, b: null }, errors: [{ message: 'b failed' }] })).toEqual({
      output: { a: 1, b: null },
    });
  });

  test('openapi, http, pipedream: data itself', () => {
    expect(callOutput('openapi', { id: 1 })).toEqual({ output: { id: 1 } });
    expect(callOutput('http', 'plain')).toEqual({ output: 'plain' });
    expect(callOutput('pipedream', [1, 2])).toEqual({ output: [1, 2] });
  });
});

describe('handleCall() upstream status and deadline', () => {
  test('an ok call names its binding and upstream status', async () => {
    const res = await handleCall(gatewayDeps(async () => ({ status: 201, body: '{"id":"c1"}' })), INPUT);
    expect(res).toMatchObject({ status: 'ok', binding: 'openapi', upstreamStatus: 201, output: { id: 'c1' } });
  });

  test('upstream 429 with Retry-After → error with upstreamStatus 429 and retryAfterSeconds; reason unchanged', async () => {
    const res = await handleCall(
      gatewayDeps(async () => ({ status: 429, body: '{"message":"slow down"}', headers: { 'Retry-After': '2' } })),
      INPUT,
    );
    expect(res).toEqual({
      status: 'error',
      reason: 'upstream_429: {"message":"slow down"}',
      binding: 'openapi',
      upstreamStatus: 429,
      retryAfterSeconds: 2,
    });
  });

  test('Retry-After as an HTTP date → seconds from now', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const res = await handleCall(
      gatewayDeps(async () => ({ status: 503, body: '', headers: { 'Retry-After': at } })),
      INPUT,
    );
    if (res.status !== 'error') throw new Error(`expected error, got ${res.status}`);
    expect(res.upstreamStatus).toBe(503);
    expect(res.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(res.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  test('every http-family upstream read carries the response size cap', async () => {
    let cap: number | undefined;
    await handleCall(
      gatewayDeps(async (init) => {
        cap = (init as { maxResponseBytes?: number }).maxResponseBytes;
        return { status: 200, body: '{}' };
      }),
      INPUT,
    );
    expect(cap).toBe(64 * 1024 * 1024);
  });

  test('a hung http upstream → upstream_timeout at the deadline, and the request is aborted', async () => {
    let aborted = false;
    const started = Date.now();
    const res = await handleCall(
      gatewayDeps(
        ({ signal }) =>
          new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
        { callTimeoutMs: 50 },
      ),
      INPUT,
    );
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.reason).toStartWith('upstream_timeout: crm.contacts.list did not answer within');
    expect(res.binding).toBe('openapi');
    expect(res.upstreamStatus).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
  });

  test('a hung provider runner that ignores the signal still answers upstream_timeout', async () => {
    const res = await handleCall(
      gatewayDeps(async () => ({ status: 200, body: '{}' }), {
        callTimeoutMs: 50,
        loadConnectorBySlug: async () => ({ ...CONNECTOR, provider: 'pipedream', hasAuth: true }),
        loadAction: async () => action({ kind: 'pipedream', app: 'crm', actionKey: 'crm-list' }),
        resolveCredential: async () => 'apn_1',
        executePipedream: () => new Promise(() => {}),
      }),
      INPUT,
    );
    expect(res).toMatchObject({ status: 'error', binding: 'pipedream' });
    if (res.status === 'error') expect(res.reason).toStartWith('upstream_timeout: ');
  });
});

describe('connectorErrorHttpStatus()', () => {
  test('upstream 429 and 503 keep their status; computer states still win; the rest is 500', () => {
    expect(connectorErrorHttpStatus('upstream_429', 429)).toBe(429);
    expect(connectorErrorHttpStatus('credential_rejected: stripe rejected the credential', 401)).toBe(424);
    expect(connectorErrorHttpStatus('upstream_503', 503)).toBe(503);
    expect(connectorErrorHttpStatus('upstream_502', 502)).toBe(500);
    expect(connectorErrorHttpStatus('upstream_timeout: x')).toBe(500);
    expect(connectorErrorHttpStatus('computer_offline: x', 429)).toBe(409);
  });
});

describe('handleCall() path arguments', () => {
  // KRTX-4539: an empty path argument went out as an empty URL segment and the
  // provider answered a misleading 404 for the truncated URL (Stripe: 101
  // `GET /v1/payment_intents/` "Unrecognized request URL" calls in one burst).
  const fetches: string[] = [];
  const ARGS_ACTION = action({ kind: 'openapi', method: 'GET', path: '/intents/{intentId}', server: 'https://crm.example.test' });

  beforeEach(() => {
    fetches.length = 0;
  });

  const inputWithArgs = (args: Record<string, unknown>) => ({ ...INPUT, args });
  // Like gatewayDeps(), but the fake fetch records the URL it was asked for.
  const trackedDeps = (overrides: Partial<GatewayDeps> = {}) =>
    gatewayDeps(async () => { throw new Error('untracked fetch'); }, {
      fetchImpl: (async (url: string) => {
        fetches.push(new URL(url).pathname);
        return { status: 200, ok: true, text: async () => '{"id":"c1"}', headers: new Headers() };
      }),
      ...overrides,
    });

  test.each([
    ['empty string', { intentId: '' }],
    ['argument absent', {}],
    ['whitespace only', { intentId: '  ' }],
    ['null', { intentId: null }],
    // The builder renders String(value): [] → '', [''] → '' — these are
    // JSON arg values whose serialized path segment is empty.
    ['empty array', { intentId: [] }],
    ['array of one empty string', { intentId: [''] }],
    // URL normalization collapses exactly the segments `.` and `..` into a
    // parent path; longer dot runs are literal segments (control below).
    ['dot-only', { intentId: '.' }],
    ['parent-segment dots', { intentId: '..' }],
  ])('path argument that serializes to nothing usable (%s) → denied before the upstream, message names it', async (_case, args) => {
    const res = await handleCall(trackedDeps({ loadAction: async () => ARGS_ACTION }), inputWithArgs(args));
    expect(res).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    if (res.status !== 'denied') return;
    expect(res.message).toContain('intentId');
    expect(fetches).toEqual([]);
  });

  test('a template with padding around the name reads the untrimmed capture the builder reads', async () => {
    // buildHttpRequest substitutes args[' intentId '] for `{ intentId }` — the
    // caller's un-padded key is invisible to it, so this renders an empty
    // segment just like a missing argument (review of KRTX-4539's fix).
    const deps = () =>
      trackedDeps({ loadAction: async () => action({ kind: 'openapi', method: 'GET', path: '/intents/{ intentId }', server: 'https://crm.example.test' }) });
    const res = await handleCall(deps(), inputWithArgs({ intentId: 'pi_1' }));
    expect(res).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    if (res.status !== 'denied') return;
    expect(res.message).toContain('intentId');
    expect(fetches).toEqual([]);
  });

  test('a non-empty path argument still calls the upstream with the encoded value', async () => {
    const res = await handleCall(trackedDeps({ loadAction: async () => ARGS_ACTION }), inputWithArgs({ intentId: 'pi_1' }));
    expect(res).toMatchObject({ status: 'ok', output: { id: 'c1' } });
    expect(fetches).toEqual(['/intents/pi_1']);
  });

  test('a dot run URL normalization leaves alone (`...`) is a literal segment and goes through', async () => {
    // remove_dot_segments collapses exactly `.` and `..`; `...` is a literal
    // segment that cannot escape the configured path, so it is a valid
    // identifier and must reach the upstream (review of KRTX-4539's fix).
    const res = await handleCall(trackedDeps({ loadAction: async () => ARGS_ACTION }), inputWithArgs({ intentId: '...' }));
    expect(res).toMatchObject({ status: 'ok', output: { id: 'c1' } });
    expect(fetches).toEqual(['/intents/...']);
  });

  test('a dot value embedded in a rendered segment with literal text around it goes through', async () => {
    // `.` inside a `.json` route: the complete rendered segment is `..json`, a
    // literal segment URL normalization leaves alone — only a WHOLE segment of
    // `.` / `..` collapses (remove_dot_segments) (review of KRTX-4539's fix).
    const deps = () =>
      trackedDeps({ loadAction: async () => action({ kind: 'openapi', method: 'GET', path: '/files/{intentId}.json', server: 'https://crm.example.test' }) });
    const res = await handleCall(deps(), inputWithArgs({ intentId: '.' }));
    expect(res).toMatchObject({ status: 'ok', output: { id: 'c1' } });
    expect(fetches).toEqual(['/files/..json']);
  });

  test('a padded dot value renders unchanged and reaches the upstream as its encoded form', async () => {
    // `' . '` is not a dot segment: encodeURIComponent makes it `%20.%20`, a
    // literal segment URL normalization never collapses into `.` — denying it
    // would block a call the provider can answer (review of KRTX-4539's fix).
    const res = await handleCall(trackedDeps({ loadAction: async () => ARGS_ACTION }), inputWithArgs({ intentId: ' . ' }));
    expect(res).toMatchObject({ status: 'ok', output: { id: 'c1' } });
    expect(fetches).toEqual(['/intents/%20.%20']);
  });

  test('a padded two-dot value embedded in a rendered segment goes through', async () => {
    // Same class with the cycle-4 embedded shape: `' .. '` on a `.json` route
    // renders `%20..%20.json`, and only a WHOLE segment of `.` / `..`
    // collapses (remove_dot_segments) (review of KRTX-4539's fix).
    const deps = () =>
      trackedDeps({ loadAction: async () => action({ kind: 'openapi', method: 'GET', path: '/files/{intentId}.json', server: 'https://crm.example.test' }) });
    const res = await handleCall(deps(), inputWithArgs({ intentId: ' .. ' }));
    expect(res).toMatchObject({ status: 'ok', output: { id: 'c1' } });
    expect(fetches).toEqual(['/files/%20..%20.json']);
  });

  test('two placeholders: the first empty one is named; both filled go through', async () => {
    const deps = () => trackedDeps({ loadAction: async () => action({ kind: 'openapi', method: 'GET', path: '/a/{xId}/b/{yId}', server: 'https://crm.example.test' }) });
    const res = await handleCall(deps(), inputWithArgs({ xId: '1' }));
    expect(res).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    if (res.status !== 'denied') return;
    expect(res.message).toContain('yId');
    expect(fetches).toEqual([]);

    const ok = await handleCall(deps(), inputWithArgs({ xId: '1', yId: '2' }));
    expect(ok.status).toBe('ok');
    expect(fetches).toEqual(['/a/1/b/2']);
  });
});

describe('POST /call wire contract', () => {
  function router(respond: Respond, overrides: Partial<GatewayDeps> = {}) {
    const principal = {
      userId: 'user-1',
      accountId: 'acct-1',
      projectId: 'proj-1',
      sessionId: null,
      subject: { userId: 'user-1', groupIds: [] },
    } as ConnectorPrincipal;
    return createConnectorRouter({
      resolvePrincipal: async () => principal,
      resolveProjectPrincipal: async () => principal,
      makeGatewayDeps: () => gatewayDeps(respond, overrides),
    } as unknown as ConnectorRouterDeps);
  }
  const post = (app: ReturnType<typeof router>) =>
    app.fetch(
      new Request('http://x/projects/proj-1/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connector: 'crm', action: 'contacts.list', args: {} }),
      }),
    );

  test('200 carries binding and upstream_status beside data; output only when it differs from data', async () => {
    // openapi `output` is `data` itself: sending both doubled every response body.
    const res = await post(router(async () => ({ status: 200, body: '{"items":[1]}' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { items: [1] },
      risk: 'read',
      binding: 'openapi',
      upstream_status: 200,
    });
  });

  test('a tool that reports an error inside a 2xx → HTTP 200, ok: false, status tool_error, error = its text', async () => {
    // The call reached the tool, so the status stays 200; ok: false says the tool did not do its job.
    const graphql = createConnectorRouter({
      resolvePrincipal: async () => ({}) as ConnectorPrincipal,
      resolveProjectPrincipal: async () =>
        ({ userId: 'user-1', accountId: 'acct-1', projectId: 'proj-1', sessionId: null, subject: { userId: 'user-1', groupIds: [] } }) as ConnectorPrincipal,
      makeGatewayDeps: () =>
        gatewayDeps(async () => ({ status: 200, body: '{"errors":[{"message":"Entity not found"}]}' }), {
          loadAction: async () => action({ kind: 'graphql', operation: 'query', field: 'issue' }),
        }),
    } as unknown as ConnectorRouterDeps);
    const res = await post(graphql);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      status: 'tool_error',
      error: 'Entity not found',
      upstream_error: 'Entity not found',
      binding: 'graphql',
      upstream_status: 200,
    });
  });

  test('200 from a GraphQL binding carries the unwrapped output', async () => {
    const graphql = createConnectorRouter({
      resolvePrincipal: async () => ({}) as ConnectorPrincipal,
      resolveProjectPrincipal: async () =>
        ({ userId: 'user-1', accountId: 'acct-1', projectId: 'proj-1', sessionId: null, subject: { userId: 'user-1', groupIds: [] } }) as ConnectorPrincipal,
      makeGatewayDeps: () =>
        gatewayDeps(async () => ({ status: 200, body: '{"data":{"issue":{"id":"i1"}}}' }), {
          loadAction: async () => action({ kind: 'graphql', operation: 'query', field: 'issue' }),
        }),
    } as unknown as ConnectorRouterDeps);
    const body = (await (await post(graphql)).json()) as Record<string, unknown>;
    expect(body.data).toEqual({ data: { issue: { id: 'i1' } } });
    expect(body.output).toEqual({ issue: { id: 'i1' } });
  });

  test('upstream 429 → HTTP 429, Retry-After header, retry_after_seconds, reason unchanged', async () => {
    const res = await post(
      router(async () => ({ status: 429, body: '{"message":"slow down"}', headers: { 'Retry-After': '2' } })),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.json()).toEqual({
      ok: false,
      status: 'error',
      reason: 'upstream_429: {"message":"slow down"}',
      binding: 'openapi',
      upstream_status: 429,
      retry_after_seconds: 2,
    });
  });

  test('a credential failure before any upstream call → HTTP 500 with binding and upstream_status null', async () => {
    // Native OAuth2 client credentials mint a token per call. A failed mint
    // never reaches the upstream, so the body names no binding and no status.
    let upstreamCalls = 0;
    const res = await post(
      router(
        async () => {
          upstreamCalls += 1;
          return { status: 200, body: '{}' };
        },
        {
          loadConnectorBySlug: async () => ({
            ...CONNECTOR,
            auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' },
            hasAuth: true,
          }),
          resolveCredential: async () => {
            throw new Error('OAuth2 token request failed (503): temporarily_unavailable');
          },
        },
      ),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      status: 'error',
      reason: 'OAuth2 token request failed (503): temporarily_unavailable',
      binding: null,
      upstream_status: null,
    });
    expect(upstreamCalls).toBe(0);
  });

  test('upstream 500 → HTTP 500 with upstream_status 500 and no Retry-After', async () => {
    const res = await post(router(async () => ({ status: 500, body: 'boom' })));
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({
      ok: false,
      status: 'error',
      reason: 'boom',
      binding: 'openapi',
      upstream_status: 500,
    });
  });
});
