import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SlackInbound } from '../channels/slack/inbound';

let loadSigningSecretCalls = 0;
let projectSigningSecret: string | null = null;
const handledBlockActions: unknown[] = [];

const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadSlackBotIdForProject: async () => null,
  ensureSlackBotId: async () => null,
  SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN',
  SLACK_SIGNING_SECRET: 'SLACK_SIGNING_SECRET',
  SLACK_TEAM_ID: 'SLACK_TEAM_ID',
  SLACK_BOT_USER_ID: 'SLACK_BOT_USER_ID',
  SLACK_TEAM_NAME: 'SLACK_TEAM_NAME',
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_WEBHOOK_SECRET',
  deleteSlackInstall: async () => {},
  listProjectsForWorkspace: async () => ['3f1c2b7e-0000-4000-8000-000000000001'],
  loadSlackInstall: async () => null,
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackSigningSecretForProject: async () => {
    loadSigningSecretCalls++;
    return projectSigningSecret;
  },
  loadSlackTeamNameForProject: async () => null,
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadTelegramWebhookSecretForProject: async () => null,
  saveSlackInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
  saveSlackOauthInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
}));

// The workspaces the project's install proved (chat_installs). A per-project
// app's signing secret is chosen by the project admin, so the body's team id
// is accepted only when it is one of these.
let provenTeams: string[] = ['T1'];
const realInbound = await import('../channels/slack/inbound');
mock.module('../channels/slack/inbound', () => ({
  ...realInbound,
  scopeProjectSlackRequest: async (projectId: string, teamId: string | null | undefined) =>
    teamId && provenTeams.includes(teamId) ? { kind: 'project', projectId, teamId } : null,
}));
const handledInbound: unknown[] = [];
const dispatchedEvents: unknown[] = [];
/** > 0 simulates the dispatch work still running when the test asserts the ack. */
let slowDispatchMs = 0;
/** Makes the dispatch work throw (after `slowDispatchMs` when that is set). */
let dispatchFails = false;
const slashCalls: unknown[] = [];
const realDispatch = await import('../channels/slack/dispatch');
mock.module('../channels/slack/dispatch', () => ({
  ...realDispatch,
  maybeHandleDmCommand: async () => false,
  dispatchSlackEvent: async (projectId: string, envelope: unknown, opts: unknown) => {
    if (slowDispatchMs > 0) await new Promise((r) => setTimeout(r, slowDispatchMs));
    if (dispatchFails) throw new Error('dispatch failed');
    dispatchedEvents.push({ projectId, envelope, opts });
  },
  ensureProjectChannelBinding: async () => {},
}));
// The durable redelivery inbox: a post-ack failure must enqueue the event here
// (the job queue retries it), a pre-ack failure must not (Slack retries a 5xx).
const redeliveries: unknown[] = [];
const redeliveryOpts: unknown[] = [];
/** > 0 makes the next N enqueue attempts throw (a DB blip the retry must survive). */
let enqueueFailures = 0;
let slackRedeliveryConsumer: ((event: unknown) => Promise<void>) | null = null;
mock.module('../integrations/event-inbox', () => ({
  emitIntegrationEvent: async (event: unknown, opts: unknown) => {
    if (enqueueFailures > 0) {
      enqueueFailures--;
      throw new Error('enqueue down');
    }
    redeliveries.push(event);
    redeliveryOpts.push(opts);
    return true;
  },
  registerEventConsumer: (_prefix: string, consumer: (event: unknown) => Promise<void>) => {
    slackRedeliveryConsumer = consumer;
  },
}));
const realCommands = await import('../channels/slack/commands');
mock.module('../channels/slack/commands', () => ({
  ...realCommands,
  handleSlashCommand: async (sub: string, _arg: string, ctx: unknown) => {
    slashCalls.push({ sub, ctx });
    return { response_type: 'ephemeral', text: 'ok' };
  },
}));
mock.module('../channels/slack/dedup', () => ({ alreadyHandled: async () => false }));

mock.module('../channels/slack/interactivity', () => ({
  handleBlockAction: async (payload: unknown, inbound: unknown) => {
    handledBlockActions.push(payload);
    handledInbound.push(inbound);
  },
  handleMessageShortcut: async () => {},
  // `mock.module` REPLACES the module, so routes.ts importing one more name
  // from it fails this whole file before a single test runs. The "Request
  // changes" modal's submit lands here.
  handleViewSubmission: async () => {},
}));

(await import('../channels/slack/routes')).registerSlackWebhookRoutes();
const { REDELIVERY_RETRY_DELAYS_MS, enqueueSlackEventRedelivery } = await import('../channels/slack/routes');
const { slackWebhookApp } = await import('../channels/slack/app');

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  loadSigningSecretCalls = 0;
  projectSigningSecret = null;
  handledBlockActions.length = 0;
  handledInbound.length = 0;
  dispatchedEvents.length = 0;
  slashCalls.length = 0;
  provenTeams = ['T1'];
  slowDispatchMs = 0;
  dispatchFails = false;
  enqueueFailures = 0;
  redeliveries.length = 0;
  redeliveryOpts.length = 0;
});

const BYO_PROJECT = '3f1c2b7e-0000-4000-8000-000000000001';
const BYO_INBOUND: SlackInbound = { kind: 'project', projectId: BYO_PROJECT, teamId: 'T1' };

function signed(body: string, contentType: string): RequestInit {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', projectSigningSecret ?? '')
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
  return {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
    body,
  };
}

describe('a per-project Slack app reaches only the workspace its install proved', () => {
  const foreignPayload = {
    type: 'block_actions',
    team: { id: 'T_OTHER' },
    user: { id: 'U1' },
    actions: [{ action_id: 'slack_request_access', value: JSON.stringify({ projectId: 'proj-other' }) }],
  };

  test('interactivity naming another workspace is refused and never handled', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ payload: JSON.stringify(foreignPayload) }).toString();
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
    expect(handledBlockActions).toEqual([]);
  });

  test('interactivity from the proven workspace is handled inside this project', async () => {
    projectSigningSecret = 'signing-secret';
    const payload = { ...foreignPayload, team: { id: 'T1' } };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(200);
    expect(handledInbound).toEqual([{ kind: 'project', projectId: '3f1c2b7e-0000-4000-8000-000000000001', teamId: 'T1' }]);
  });

  test('a slash command naming another workspace is refused and never run', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ command: '/kortix', text: 'logout', team_id: 'T_OTHER', user_id: 'U1', channel_id: 'C1' }).toString();
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/commands', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
    expect(slashCalls).toEqual([]);
  });

  test('a slash command from the proven workspace runs scoped to this project', async () => {
    projectSigningSecret = 'signing-secret';
    const body = new URLSearchParams({ command: '/kortix', text: 'help', team_id: 'T1', user_id: 'U1', channel_id: 'C1' }).toString();
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/commands', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(200);
    expect(slashCalls).toEqual([{ sub: 'help', ctx: expect.objectContaining({ teamId: 'T1', projectScopedProjectId: '3f1c2b7e-0000-4000-8000-000000000001' }) }]);
  });

  test('an event naming another workspace is refused and never dispatched', async () => {
    projectSigningSecret = 'signing-secret';
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev9',
      team_id: 'T_OTHER',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001', signed(body, 'application/json'));
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatchedEvents).toEqual([]);
  });

  test('an event_callback acks at EVENT_ACK_WAIT_MS, not the 2 s webhook budget', async () => {
    projectSigningSecret = 'signing-secret';
    // A mention whose work outlasts the event-callback ack budget (a session
    // spawn on prod takes 300 ms - 2 s); the 2 s route budget would return at
    // the work's wall time, the event budget returns at the budget.
    slowDispatchMs = 900;
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvSlow',
      team_id: 'T1',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const started = Date.now();
    const res = await slackWebhookApp.request(
      '/3f1c2b7e-0000-4000-8000-000000000001',
      signed(body, 'application/json'),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(slowDispatchMs).toBe(900);
    // Work still dispatches after the ack (the route reads the dispatch itself).
    await new Promise((r) => setTimeout(r, 750));
    expect(dispatchedEvents).toHaveLength(1);
    // The 250 ms event budget gated the ack; with the shared 2 s budget this
    // request answered at the 900 ms work (and ≥2 s when the work is slower).
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(500);
  });

  test('a dispatch that fails after the ack is queued for durable redelivery', async () => {
    projectSigningSecret = 'signing-secret';
    slowDispatchMs = 900; // the failure lands after the 250 ms ack went out
    dispatchFails = true;
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvFail',
      team_id: 'T1',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const res = await slackWebhookApp.request(`/${BYO_PROJECT}`, signed(body, 'application/json'));
    expect(res.status).toBe(200); // the ack does not wait for the failure
    // The detached work fails at ~900 ms; poll for its durable redelivery.
    for (let i = 0; i < 40 && redeliveries.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(redeliveries).toHaveLength(1);
    const event = redeliveries[0] as {
      id: string;
      type: string;
      source: string;
      data: { envelope: { event_id: string }; inbound: unknown };
    };
    expect(event.id).toBe('EvFail');
    expect(event.type).toBe('slack.event.redelivery');
    expect(event.source).toBe(`slack:${BYO_PROJECT}`);
    expect(event.data.envelope.event_id).toBe('EvFail');
    expect(event.data.inbound).toEqual(BYO_INBOUND);
  });

  test('a dispatch that fails inside the ack window answers 500 and queues no redelivery', async () => {
    projectSigningSecret = 'signing-secret';
    dispatchFails = true; // fails at once — inside the 250 ms ack window
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvFast',
      team_id: 'T1',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const res = await slackWebhookApp.request(`/${BYO_PROJECT}`, signed(body, 'application/json'));
    expect(res.status).toBe(500); // Slack retries a 5xx: that retry is the redelivery
    await new Promise((r) => setTimeout(r, 50));
    expect(redeliveries).toEqual([]);
  });

  test('a failed enqueue is retried before the redelivery is scheduled', async () => {
    projectSigningSecret = 'signing-secret';
    slowDispatchMs = 900;
    dispatchFails = true;
    enqueueFailures = 2; // the first two enqueue attempts throw; the third lands
    REDELIVERY_RETRY_DELAYS_MS.splice(0, REDELIVERY_RETRY_DELAYS_MS.length, 0, 5, 5);
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvRetry',
      team_id: 'T1',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
    });
    const res = await slackWebhookApp.request(`/${BYO_PROJECT}`, signed(body, 'application/json'));
    expect(res.status).toBe(200);
    for (let i = 0; i < 40 && redeliveries.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(redeliveries).toHaveLength(1); // the retry, not the failure, schedules the redelivery
    REDELIVERY_RETRY_DELAYS_MS.splice(0, REDELIVERY_RETRY_DELAYS_MS.length, 0, 1_000, 5_000);
  });

  test('a redelivery scheduled while the dedup claim still holds waits out the claim TTL', async () => {
    projectSigningSecret = 'signing-secret';
    REDELIVERY_RETRY_DELAYS_MS.splice(0, REDELIVERY_RETRY_DELAYS_MS.length, 0);
    const envelope = { type: 'event_callback', event_id: 'EvHold', event: { type: 'app_mention' } };
    await enqueueSlackEventRedelivery(envelope, BYO_INBOUND, { claimsReleased: false });
    const held = redeliveryOpts[0] as { runAt?: Date };
    // The claim's TTL (5 min) plus margin: before it, the consumer would find
    // the stale claim held and skip the replay.
    expect(held.runAt?.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);

    await enqueueSlackEventRedelivery({ ...envelope, event_id: 'EvFree' }, BYO_INBOUND, {
      claimsReleased: true,
    });
    const freed = redeliveryOpts[1] as { runAt?: Date };
    expect(freed.runAt).toBeUndefined(); // the claim released: the queue can run the replay at once
    REDELIVERY_RETRY_DELAYS_MS.splice(0, REDELIVERY_RETRY_DELAYS_MS.length, 0, 1_000, 5_000, 30_000, 60_000, 120_000, 300_000);
  });

  test('a redelivery replays the stored event through the same dispatch', async () => {
    projectSigningSecret = 'signing-secret';
    if (!slackRedeliveryConsumer) throw new Error('the slack redelivery consumer did not register');
    await slackRedeliveryConsumer({
      id: 'EvAgain',
      source: `slack:${BYO_PROJECT}`,
      type: 'slack.event.redelivery',
      time: new Date().toISOString(),
      subject: null,
      projectId: BYO_PROJECT,
      data: {
        envelope: {
          type: 'event_callback',
          event_id: 'EvAgain',
          event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
        },
        inbound: BYO_INBOUND,
      },
    });
    expect(dispatchedEvents).toHaveLength(1);
  });

  test('a redelivery whose work fails throws so the job queue retries it', async () => {
    projectSigningSecret = 'signing-secret';
    dispatchFails = true;
    if (!slackRedeliveryConsumer) throw new Error('the slack redelivery consumer did not register');
    await expect(
      slackRedeliveryConsumer({
        id: 'EvAgainFail',
        source: `slack:${BYO_PROJECT}`,
        type: 'slack.event.redelivery',
        time: new Date().toISOString(),
        subject: null,
        projectId: BYO_PROJECT,
        data: {
          envelope: {
            type: 'event_callback',
            event_id: 'EvAgainFail',
            event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0', text: 'hi' },
          },
          inbound: BYO_INBOUND,
        },
      }),
    ).rejects.toThrow('redelivery');
  });

  test('an install with no proven workspace refuses every signed callback', async () => {
    projectSigningSecret = 'signing-secret';
    provenTeams = [];
    const body = new URLSearchParams({ payload: JSON.stringify({ ...foreignPayload, team: { id: 'T1' } }) }).toString();
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/interactivity', signed(body, 'application/x-www-form-urlencoded'));
    expect(res.status).toBe(403);
  });
});

describe('BYO Slack Events API URL verification', () => {
  test('answers the verification challenge before a project signing secret exists', async () => {
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url_verification',
        challenge: 'slack-challenge',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'slack-challenge' });
    expect(loadSigningSecretCalls).toBe(0);
  });

  test('still requires a project signing secret for real event callbacks', async () => {
    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event_callback',
        event_id: 'Ev1',
        team_id: 'T1',
        event: { type: 'app_mention', channel: 'C1', user: 'U1', ts: '1.0' },
      }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not configured' });
    expect(loadSigningSecretCalls).toBe(1);
  });

  test('interactivity acks block actions with an empty body', async () => {
    projectSigningSecret = 'signing-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      actions: [{ action_id: 'slack_login_connect', value: '{}' }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = `v0=${createHmac('sha256', projectSigningSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex')}`;

    const res = await slackWebhookApp.request('/3f1c2b7e-0000-4000-8000-000000000001/interactivity', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(handledBlockActions).toEqual([payload]);
  });
});

// An unsigned request is invalid even when this host has no OAuth installation.
test('OAuth webhook rejects unsigned requests before checking installation configuration', async () => {
  const response = await slackWebhookApp.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'event_callback' }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Invalid signature' });
});
