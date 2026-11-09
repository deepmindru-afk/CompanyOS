/**
 * A server-side connector call with no session: what an app-event poller runs.
 * `handleCall(makeDbGatewayDeps(principal))` with `sessionId: null` and the
 * project account named reaches a real MCP server (a loopback fake) through the
 * real gateway. The gateway applies project policy only: with none, a write
 * runs too, so a poller must keep itself to read tools.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, connectorActions, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { handleCall } from './gateway';
import { makeDbGatewayDeps } from './db-deps-gateway';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const CONNECTION = crypto.randomUUID();
const calls: Array<{ method: string; params: unknown }> = [];

const mcp = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string; params?: Record<string, unknown> };
    calls.push({ method: body.method, params: body.params });
    if (body.method === 'tools/call') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'a1' }, { id: 'a2' }] }) }], structuredContent: { items: [{ id: 'a1' }, { id: 'a2' }] } } });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
  },
});

let previousAllow: readonly string[] = [];

beforeAll(async () => {
  previousAllow = config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS;
  (config as { KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: readonly string[] }).KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = ['127.0.0.1'];
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'server-call-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'server-call', repoUrl: 'https://example.test/s.git' });
  await db.insert(connectors).values({
    connectorId: CONNECTOR, accountId: ACCOUNT, projectId: PROJECT, slug: 'fake', name: 'Fake', providerType: 'mcp',
    config: { url: `http://127.0.0.1:${mcp.port}/mcp`, transport: 'http', auth: { type: 'none', in: 'header', name: null, prefix: null } },
  });
  await db.insert(connectorActions).values([
    { connectorId: CONNECTOR, path: 'list_items', name: 'list_items', risk: 'read', binding: { kind: 'mcp', tool: 'list_items' } },
  ]);
  await db.insert(connectorConnections).values({ connectionId: CONNECTION, accountId: ACCOUNT, projectId: PROJECT, connectorId: CONNECTOR, label: 'Shared', ownerType: 'project', isDefault: true });
});

afterAll(async () => {
  (config as { KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: readonly string[] }).KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS = previousAllow;
  mcp.stop(true);
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

function principal(owner: string, account?: string | null) {
  return { userId: owner, accountId: ACCOUNT, projectId: PROJECT, sessionId: null, subject: { userId: owner, groupIds: [] }, agentGrant: null, requestedConnectorAccount: account ?? CONNECTION };
}

test('a sessionless call as the project account runs a read tool on the MCP server', async () => {
  const owner = ACCOUNT;
  const result = await handleCall(makeDbGatewayDeps(principal(owner)), {
    projectId: PROJECT, accountId: ACCOUNT, subject: { userId: owner, groupIds: [] }, sessionId: null,
    connectorSlug: 'fake', actionPath: 'list_items', args: { pageSize: 5 },
  });
  expect(result).toMatchObject({ status: 'ok', binding: 'mcp', account: { connection_id: CONNECTION } });
  expect(calls.find((c) => c.method === 'tools/call')?.params).toEqual({ name: 'list_items', arguments: { pageSize: 5 } });
  expect(result.status === 'ok' && result.output).toEqual({ items: [{ id: 'a1' }, { id: 'a2' }] });
});

test('a catalog (openapi) action denies an empty path argument before any upstream call', async () => {
  // KRTX-4539: an empty id went out as `/intents/` and the provider answered
  // a misleading 404 for the truncated URL. The deny needs no connection, no
  // credential and no egress: it answers with the argument the caller must fill.
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      calls.push({ method: req.method, params: new URL(req.url).pathname });
      return Response.json({ id: 'up-1' });
    },
  });
  try {
    const ogConnector = crypto.randomUUID();
    await db.insert(connectors).values({
      connectorId: ogConnector, accountId: ACCOUNT, projectId: PROJECT, slug: 'ogfake', name: 'Og Fake', providerType: 'openapi',
      config: { server: `http://127.0.0.1:${http.port}`, auth: { type: 'none', in: 'header', name: null, prefix: null } },
    });
    await db.insert(connectorActions).values({
      connectorId: ogConnector, path: 'get_intent', name: 'get_intent', risk: 'read',
      binding: { kind: 'openapi', method: 'GET', path: '/intents/{intentId}', server: `http://127.0.0.1:${http.port}` },
    });
    await db.insert(connectorConnections).values({
      connectionId: crypto.randomUUID(), accountId: ACCOUNT, projectId: PROJECT, connectorId: ogConnector,
      label: 'Solog', ownerType: 'project', isDefault: true,
    });
    const owner = ACCOUNT;
    const empty = await handleCall(makeDbGatewayDeps(principal(owner, 'Solog')), {
      projectId: PROJECT, accountId: ACCOUNT, subject: { userId: owner, groupIds: [] }, sessionId: null,
      connectorSlug: 'ogfake', actionPath: 'get_intent', args: { intentId: '' },
    });
    expect(empty).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    if (empty.status !== 'denied') return;
    expect(empty.message).toContain('intentId');
    // Edge cases reachable only through caller JSON, not the seed above:
    // String([]) renders the same empty segment (review of KRTX-4539's fix).
    // The configured credential needs no connection row: the deny fires before it.
    const emptyArray = await handleCall(makeDbGatewayDeps(principal(owner, 'Solog')),
      { projectId: PROJECT, accountId: ACCOUNT, subject: { userId: owner, groupIds: [] }, sessionId: null,
        connectorSlug: 'ogfake', actionPath: 'get_intent', args: { intentId: [] } });
    expect(emptyArray).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    if (emptyArray.status !== 'denied') return;
    expect(emptyArray.message).toContain('intentId');
    const filled = await handleCall(makeDbGatewayDeps(principal(owner, 'Solog')), {
      projectId: PROJECT, accountId: ACCOUNT, subject: { userId: owner, groupIds: [] }, sessionId: null,
      connectorSlug: 'ogfake', actionPath: 'get_intent', args: { intentId: 'pi_1' },
    });
    expect(filled).toMatchObject({ status: 'ok', binding: 'openapi' });
    expect(calls.at(-1)).toEqual({ method: 'GET', params: '/intents/pi_1' });
    await db.delete(connectors).where(eq(connectors.connectorId, ogConnector));
  } finally {
    http.stop(true);
  }
});
