import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { chatInstalls } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { generateSlackManifest, resolveBaseUrl } from '../slack-manifest';
import { loadSlackSigningSecretForProject } from '../install-store';
import { slackOauthMode } from '../slack-oauth-mode';
import { json, errors } from '../../openapi';
import { slackWebhookApp } from './app';
import { alreadyHandled } from './dedup';
import { EVENT_DEDUPE_TTL_MS } from './app';
import { parseEnvelope, verifySlackSignature } from './util';
import {
  dispatchSlackEvent,
  ensureProjectChannelBinding,
  handleAssistantThreadStarted,
  maybeHandleDmCommand,
  maybePostChannelIntro,
  maybePostPicker,
  resolveOauthProject,
} from './dispatch';
import { publishHomeForUser } from './home';
import { handleBlockAction, handleMessageShortcut, handleViewSubmission } from './interactivity';
import { handleSlashCommand } from './commands';
import {
  CANONICAL_SLACK_INBOUND,
  inboundProjectId,
  scopeProjectSlackRequest,
  type ProjectSlackInbound,
  type SlackInbound,
} from './inbound';
import type { SlackEnvelope, SlackInteractionPayload, SlashResponse } from './types';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { EVENT_ACK_WAIT_MS, runWebhookWork, type WebhookOutcome } from '../webhook-work';
import { workspaceIdParam } from '../../shared/route-params';
import { emitIntegrationEvent, registerEventConsumer, type IntegrationEvent } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';

// ── Shared slash + interactivity processing ───────────────────────────────────
// The canonical OAuth app and per-project (BYO) apps run the SAME logic. They
// differ in which signing secret verifies the request, and so in what the
// request may reach (see `SlackInbound`). Each route does its own signature
// check, then hands the verified raw body and its inbound scope to these.

const WORKSPACE_MISMATCH = { error: 'This Slack workspace is not connected to this workspace' };

/**
 * Verify a per-project (BYO) request: the project's own signing secret, then
 * the workspace the install proved. Returns the inbound scope, or the refusal.
 */
async function verifyProjectSlackRequest(
  c: any,
  projectId: string,
  rawBody: string,
  bodyTeamId: string | null | undefined,
): Promise<{ inbound: ProjectSlackInbound } | { refusal: Response }> {
  const signingSecret = await loadSlackSigningSecretForProject(projectId);
  if (!signingSecret) return { refusal: c.json({ error: 'Not configured' }, 404) };
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const signature = c.req.header('x-slack-signature') ?? '';
  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    return { refusal: c.json({ error: 'Invalid signature' }, 401) };
  }
  // The project admin chose the signing secret, so the body's workspace id is
  // only as trustworthy as that admin. Accept it only when it is a workspace
  // the install's bot token proved.
  const inbound = await scopeProjectSlackRequest(projectId, bodyTeamId);
  if (!inbound) return { refusal: c.json(WORKSPACE_MISMATCH, 403) };
  return { inbound };
}

function interactionPayload(rawBody: string): SlackInteractionPayload | null {
  const payloadRaw = new URLSearchParams(rawBody).get('payload');
  if (!payloadRaw) return null;
  try {
    return JSON.parse(payloadRaw) as SlackInteractionPayload;
  } catch {
    return null;
  }
}

/** Parse a slash-command form body and run it → the Slack response object. */
async function runSlashCommandBody(
  rawBody: string,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<SlashResponse> {
  const params = new URLSearchParams(rawBody);
  const text = (params.get('text') ?? '').trim();
  const teamId = inbound.kind === 'project' ? inbound.teamId : (params.get('team_id') ?? '');
  const projectScopedProjectId = inboundProjectId(inbound);
  const channelId = params.get('channel_id') ?? '';
  const slackUserId = params.get('user_id') ?? '';
  const command = params.get('command') || '/kortix';
  const responseUrl = params.get('response_url') ?? undefined;

  if (projectScopedProjectId && teamId && channelId) {
    await ensureProjectChannelBinding(projectScopedProjectId, teamId, channelId);
  }

  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const subLower = (sub || 'help').toLowerCase();
  try {
    return await handleSlashCommand(subLower, arg, {
      teamId,
      channelId,
      slackUserId,
      command,
      responseUrl,
      projectScopedProjectId,
    });
  } catch (err) {
    console.error('[slack-webhook] slash command failed', err);
    return {
      response_type: 'ephemeral',
      text: 'Something went wrong handling that command. Try again in a moment.',
    };
  }
}

/**
 * Parse an interactivity form body and run the right handler.
 *
 * Returns the payload type, because the ACK Slack expects differs by it. For a
 * `view_submission` the 200 body is read as a `response_action`: anything that
 * is not one — `{"ok":true"}` included — shows the reviewer an error instead of
 * closing the modal. An empty body is the "accepted, close it" answer.
 *
 * A handler that fails inside the ack window answers 500: Slack shows the user
 * a warning, so the click is not lost without a trace. Slower work finishes in
 * the background and the shutdown drain waits for it.
 */
async function runInteractivityBody(
  rawBody: string,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<{ type: string | null; outcome: WebhookOutcome }> {
  const payload = interactionPayload(rawBody);
  if (!payload) return { type: null, outcome: 'done' };
  const work =
    payload.type === 'block_actions'
      ? () => handleBlockAction(payload, inbound)
      : payload.type === 'message_action'
        ? () => handleMessageShortcut(payload, inbound)
        : // Without this the "Request changes" modal's Send button closes the view
          // and drops the reviewer's note on the floor.
          payload.type === 'view_submission'
          ? () => handleViewSubmission(payload, inbound)
          : null;
  const outcome = work
    ? await runWebhookWork('slack-interactivity', async () => void (await work()))
    : 'done';
  return { type: payload.type ?? null, outcome };
}

// ── Slack event-callback work ────────────────────────────────────────────────────
// The two event routes' work bodies, named so the durable redelivery (a failed
// post-ack event, replayed from the job queue) runs the EXACT same steps.

/** The canonical OAuth app's event-callback work (`POST /v1/webhooks/slack`). */
async function processOauthEventCallback(envelope: SlackEnvelope): Promise<void> {
  if (await alreadyHandled(envelope.event_id)) return;
  const teamId = envelope.team_id ?? envelope.event?.team ?? '';
  if (!teamId) return;
  if (envelope.event?.type === 'member_joined_channel') {
    await maybePostChannelIntro(teamId, envelope.event);
    return;
  }
  if (
    envelope.event?.type === 'app_home_opened' &&
    envelope.event.tab === 'home' &&
    envelope.event.user
  ) {
    await publishHomeForUser(teamId, envelope.event.user);
    return;
  }
  // Opening the Kortix DM (AI-Assistant pane) → greet with the project picker.
  // The channel/thread live on event.assistant_thread, NOT the top-level event,
  // so resolveOauthProject can't see it — handle it before that branch.
  if (envelope.event?.type === 'assistant_thread_started') {
    await handleAssistantThreadStarted(teamId, envelope.event);
    return;
  }
  // A `/kortix …` typed in a DM (the Assistant pane can't run real slash
  // commands) arrives as a plain message — run it as the command it is.
  if (envelope.event && (await maybeHandleDmCommand(teamId, envelope.event))) {
    return;
  }
  const resolution = await resolveOauthProject(
    teamId,
    envelope.event?.channel,
    envelope.event?.thread_ts,
  );
  if (resolution.kind === 'project') {
    await dispatchSlackEvent(resolution.projectId, envelope);
  } else if (resolution.kind === 'ambiguous') {
    await maybePostPicker(teamId, resolution.projectIds, envelope);
  } else if (resolution.kind === 'pending') {
    const installs = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.platformTeamId, teamId)));
    if (installs.length > 0) {
      await maybePostPicker(
        teamId,
        installs.map((i) => i.projectId),
        envelope,
      );
    }
  }
}

/** A per-project (BYO) app's event-callback work (`POST /v1/webhooks/slack/:workspaceId`). */
async function processByoEventCallback(envelope: SlackEnvelope, inbound: ProjectSlackInbound): Promise<void> {
  // Scoped per project: this is a BYO app with its own event id space, and
  // another project (or the canonical app) may deliver the same event_id.
  if (await alreadyHandled(envelope.event_id, { projectId: inbound.projectId })) return;
  const teamId = inbound.teamId;
  if (envelope.event && (await maybeHandleDmCommand(teamId, envelope.event, inbound.projectId))) {
    return;
  }
  await dispatchSlackEvent(inbound.projectId, envelope, { ownThreadsOnly: true });
}

/** The redelivery job's ack-budget warn point, and the claim visibility that must exceed the work's worst run. */
const SLACK_REDELIVERY_WAIT_MS = 5 * 60_000;
const SLACK_REDELIVERY_VISIBILITY_MS = 10 * 60_000;

/** The durable-enqueue retry schedule (~8.6 min of coverage — longer than the 500-retry window of the 2 s-budget code, which is the recovery this replaces). Tests shrink the waits. */
export const REDELIVERY_RETRY_DELAYS_MS = [0, 1_000, 5_000, 30_000, 60_000, 120_000, 300_000];

/**
 * A failure that lands after the ack went out loses the event: the provider got
 * its 2xx and will not redeliver, and releasing the dedup claim schedules
 * nothing. Enqueue the event on the durable job queue (retries with backoff,
 * dead-letters, runbook in integrations/event-inbox.ts) so the work replays.
 * The enqueue itself is retried over minutes: a DB blip or a short outage must
 * not be the thing that eats the redelivery — the schedule covers more than the
 * Slack-retry window the 500 path used to get. When even that fails, the throw
 * is the loss signal. When the dedup claim's release failed, the redelivery
 * waits out the claim's TTL (`runAt`) so the consumer can re-take it.
 */
export async function enqueueSlackEventRedelivery(
  envelope: SlackEnvelope,
  inbound: SlackInbound | undefined,
  opts: { claimsReleased: boolean },
): Promise<void> {
  if (!envelope.event_id) {
    logger.warn('[slack-webhook] event work failed after the ack; the event has no id, so it cannot be redelivered');
    return;
  }
  const projectId = inbound?.kind === 'project' ? inbound.projectId : undefined;
  const eventId = envelope.event_id;
  const runAt = opts.claimsReleased
    ? undefined
    : new Date(Date.now() + EVENT_DEDUPE_TTL_MS + 60_000);
  const store = (): Promise<boolean> =>
    emitIntegrationEvent({
      id: eventId,
      source: projectId ? `slack:${projectId}` : 'slack:canonical',
      type: 'slack.event.redelivery',
      time: new Date().toISOString(),
      subject: null,
      projectId: projectId ?? '',
      data: { envelope, inbound: inbound ?? null },
    }, { ...(runAt ? { runAt } : {}) });
  let inserted = false;
  let scheduled = false;
  for (const delay of REDELIVERY_RETRY_DELAYS_MS) {
    await Bun.sleep(delay);
    try {
      inserted = await store();
      scheduled = true; // true: queued; false: the (queue, key) exists — scheduled either way
      break;
    } catch (err) {
      logger.error('[slack-webhook] redelivery enqueue attempt failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!scheduled) throw new Error('redelivery enqueue failed after every retry — the event is lost');
  if (inserted) logger.warn('[slack-webhook] event work failed after the ack — durable redelivery queued');
}

/**
 * Replay one stored event. Runs inside `runWebhookWork` so a failed replay
 * releases its dedup claim (the queue's next attempt must be able to re-take
 * it) and is drain-tracked; `awaitSettlement` holds the job open until the work
 * settles, so a `failed` throw retries the job with backoff and dead-letters it
 * after its attempts (the runbook above) — a completed job is never retried.
 */
export async function redeliverSlackEvent(event: IntegrationEvent): Promise<void> {
  const { envelope, inbound } = (event.data ?? {}) as {
    envelope?: SlackEnvelope;
    inbound?: ProjectSlackInbound | null;
  };
  if (!envelope?.event) throw new Error('slack event redelivery payload has no envelope');
  if (inbound) bindIntegrationPrincipal('slack', { projectId: inbound.projectId });
  else bindIntegrationPrincipal('slack');
  const outcome = await runWebhookWork(
    'slack-event-redelivery',
    () => (inbound ? processByoEventCallback(envelope, inbound) : processOauthEventCallback(envelope)),
    { ackWaitMs: SLACK_REDELIVERY_WAIT_MS, awaitSettlement: true },
  );
  if (outcome === 'failed') throw new Error('slack event redelivery failed — the job queue retries it with backoff');
}

registerEventConsumer('slack.', redeliverSlackEvent, { visibilityMs: SLACK_REDELIVERY_VISIBILITY_MS });

export function registerSlackWebhookRoutes(): void {
  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['channels'],
      summary: 'Slack Events API webhook (signature verified)',
      request: {
        body: { content: { 'application/json': { schema: z.any() } } },
      },
      responses: {
        200: json(
          z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(),
          'Accepted',
        ),
        ...errors(400, 401, 503),
      },
    }),
    async (c: any) => {
      if (!c.req.header('x-slack-request-timestamp') || !c.req.header('x-slack-signature')) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
      const mode = slackOauthMode();
      if (!mode.available || !mode.signingSecret) {
        return c.json({ error: 'OAuth mode not configured' }, 503);
      }

      const rawBody = await c.req.text();
      const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
      const signature = c.req.header('x-slack-signature') ?? '';
      if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
      bindIntegrationPrincipal('slack');

      const envelope = parseEnvelope(rawBody);
      if (!envelope) return c.json({ error: 'Invalid JSON' }, 400);
      if (envelope.type === 'url_verification') return c.json({ challenge: envelope.challenge });
      if (envelope.type !== 'event_callback' || !envelope.event) return c.json({ ok: true });
      // The 200 body is `{ok:true}` Slack never reads — ack fast
      // (EVENT_ACK_WAIT_MS) and let the work finish detached. A failure that
      // lands after the ack is enqueued for durable redelivery (Slack will not
      // retry a 2xx, and releasing the claim alone schedules nothing).
      const outcome = await runWebhookWork('slack-oauth-event', () => processOauthEventCallback(envelope), {
        ackWaitMs: EVENT_ACK_WAIT_MS,
        onLost: ({ claimsReleased }) => enqueueSlackEventRedelivery(envelope, undefined, { claimsReleased }),
      });
      if (outcome === 'failed') return c.json({ error: 'processing failed' }, 500);

      return c.json({ ok: true });
    },
  );

  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/interactivity',
      tags: ['channels'],
      summary: 'Slack interactivity webhook (signature verified)',
      request: {
        body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
      },
      responses: {
        200: json(z.object({ ok: z.boolean() }).passthrough(), 'Accepted'),
        ...errors(401, 503),
      },
    }),
    async (c: any) => {
      const mode = slackOauthMode();
      if (!mode.available || !mode.signingSecret) {
        return c.json({ error: 'OAuth mode not configured' }, 503);
      }
      const rawBody = await c.req.text();
      const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
      const signature = c.req.header('x-slack-signature') ?? '';
      if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
      bindIntegrationPrincipal('slack');
      // An empty body closes a modal; `{ok:true}` would be read as a malformed
      // `response_action` and show the reviewer an error.
      const { type, outcome } = await runInteractivityBody(rawBody);
      if (outcome === 'failed') return c.json({ error: 'processing failed' }, 500);
      if (type === 'view_submission') return c.body('', 200);
      return c.json({ ok: true });
    },
  );

  // Slash commands — Slack POSTs application/x-www-form-urlencoded here when
  // a user runs `/kortix …` in any channel/DM. Must respond within 3s.
  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/commands',
      tags: ['channels'],
      summary: 'Slack slash command webhook (signature verified)',
      request: {
        body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
      },
      responses: {
        200: json(
          z
            .object({ response_type: z.string().optional(), text: z.string().optional() })
            .passthrough(),
          'Slash command response',
        ),
        ...errors(401, 503),
      },
    }),
    async (c: any) => {
      const mode = slackOauthMode();
      if (!mode.available || !mode.signingSecret) {
        return c.json(
          { response_type: 'ephemeral', text: 'OAuth mode not configured on this server.' },
          503,
        );
      }
      const rawBody = await c.req.text();
      const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
      const signature = c.req.header('x-slack-signature') ?? '';
      if (!verifySlackSignature(rawBody, timestamp, signature, mode.signingSecret)) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
      bindIntegrationPrincipal('slack');

      return c.json(await runSlashCommandBody(rawBody));
    },
  );

  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}',
      tags: ['channels'],
      summary: 'Per-project (BYO app) Slack Events webhook (signature verified)',
      request: {
        params: z.object({
          // A project id is always a UUID. Without this, a non-UUID path segment
          // reached the projects DB lookup, which threw on the invalid input and
          // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
          workspaceId: z.string().uuid(),
        }),
        body: { content: { 'application/json': { schema: z.any() } } },
      },
      responses: {
        200: json(
          z.object({ ok: z.boolean().optional(), challenge: z.string().optional() }).passthrough(),
          'Accepted',
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const rawBody = await c.req.text();

      const envelope = parseEnvelope(rawBody);
      if (!envelope) return c.json({ error: 'Invalid JSON' }, 400);
      // Slack verifies the Events API request URL before a manual/BYO app can be
      // installed and saved back to Kortix, so there is no project signing secret
      // yet. Only the bootstrap challenge is allowed through this unsigned path;
      // every real callback below remains project-secret verified.
      if (envelope.type === 'url_verification') return c.json({ challenge: envelope.challenge });

      const verified = await verifyProjectSlackRequest(c, projectId, rawBody, envelope.team_id);
      if ('refusal' in verified) return verified.refusal;
      const { inbound } = verified;
      bindIntegrationPrincipal('slack', { projectId });

      if (envelope.type !== 'event_callback' || !envelope.event) return c.json({ ok: true });
      // The 200 body is `{ok:true}` Slack never reads — ack fast
      // (EVENT_ACK_WAIT_MS) and let the work finish detached; a post-ack
      // failure is enqueued for durable redelivery (see the canonical route).
      const outcome = await runWebhookWork('slack-byo-event', () => processByoEventCallback(envelope, inbound), {
        ackWaitMs: EVENT_ACK_WAIT_MS,
        onLost: ({ claimsReleased }) => enqueueSlackEventRedelivery(envelope, inbound, { claimsReleased }),
      });
      if (outcome === 'failed') return c.json({ error: 'processing failed' }, 500);
      return c.json({ ok: true });
    },
  );

  // Per-project (BYO app) slash commands — parity with the canonical /commands,
  // verified with the project's OWN signing secret. The BYO manifest points its
  // slash command url here.
  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/commands',
      tags: ['channels'],
      summary: 'Per-project (BYO app) Slack slash command webhook (signature verified)',
      request: {
        params: z.object({
          // A project id is always a UUID. Without this, a non-UUID path segment
          // reached the projects DB lookup, which threw on the invalid input and
          // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
          workspaceId: z.string().uuid(),
        }),
        body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
      },
      responses: {
        200: json(
          z
            .object({ response_type: z.string().optional(), text: z.string().optional() })
            .passthrough(),
          'Slash command response',
        ),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const rawBody = await c.req.text();
      const bodyTeamId = new URLSearchParams(rawBody).get('team_id');
      const verified = await verifyProjectSlackRequest(c, projectId, rawBody, bodyTeamId);
      if ('refusal' in verified) return verified.refusal;
      bindIntegrationPrincipal('slack', { projectId });
      return c.json(await runSlashCommandBody(rawBody, verified.inbound));
    },
  );

  // Per-project (BYO app) interactivity — parity with the canonical /interactivity
  // (block-action pickers + the "Open in Kortix" message shortcut), verified with
  // the project's own signing secret. The BYO manifest points interactivity here.
  slackWebhookApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/interactivity',
      tags: ['channels'],
      summary: 'Per-project (BYO app) Slack interactivity webhook (signature verified)',
      request: {
        params: z.object({
          // A project id is always a UUID. Without this, a non-UUID path segment
          // reached the projects DB lookup, which threw on the invalid input and
          // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
          workspaceId: z.string().uuid(),
        }),
        body: { content: { 'application/x-www-form-urlencoded': { schema: z.any() } } },
      },
      responses: {
        200: json(z.object({ ok: z.boolean() }).passthrough(), 'Accepted'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const rawBody = await c.req.text();
      const bodyTeamId = interactionPayload(rawBody)?.team?.id;
      const verified = await verifyProjectSlackRequest(c, projectId, rawBody, bodyTeamId);
      if ('refusal' in verified) return verified.refusal;
      bindIntegrationPrincipal('slack', { projectId });
      // The project scope travels with the payload: every handler behind this
      // route stays inside this project and its proven workspace.
      const { outcome } = await runInteractivityBody(rawBody, verified.inbound);
      if (outcome === 'failed') return c.json({ error: 'processing failed' }, 500);
      return c.body('', 200);
    },
  );

  // The per-project (BYO) Slack manifest — served from the SAME builder the
  // canonical app uses, so the in-sandbox `kortix-agent slack manifest` command
  // fetches this instead of carrying its own copy. No secrets, no DB: it's a
  // scaffolding template (the project may not have Slack configured yet), so it's
  // intentionally unauthenticated and works for any projectId.
  slackWebhookApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/manifest',
      tags: ['channels'],
      summary: 'Per-project (BYO app) Slack app manifest (single source of truth)',
      request: {
        params: z.object({
          // A project id is always a UUID. Without this, a non-UUID path segment
          // reached the projects DB lookup, which threw on the invalid input and
          // surfaced as a 500 to an anonymous caller (pentest 2026-10-22).
          workspaceId: z.string().uuid(),
        }),
        query: z.object({ name: z.string().optional(), command: z.string().optional() }),
      },
      responses: {
        200: json(z.any(), 'Slack app manifest JSON'),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const name = c.req.query('name') || undefined;
      const command = c.req.query('command') || undefined;
      // Prefer the configured public URL; fall back to the request host.
      const baseUrl = resolveBaseUrl(new URL(c.req.url), config.KORTIX_URL || undefined);
      return c.json(
        generateSlackManifest({ baseUrl, projectId, appName: name, botName: name, command }),
      );
    },
  );
}
