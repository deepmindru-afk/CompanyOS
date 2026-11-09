/**
 * The model and agent a chat conversation runs on, for every platform.
 *
 * A chat's choice is a settings row (`chat_channel_bindings`) the adapter keys
 * (`SettingsChannel`). A chat everyone in it shares uses only keys the whole
 * project shares: no one's personal key or ChatGPT subscription
 * (channels/model-access.ts).
 */
import { projectSessions } from '@kortix/db';
import type { ChannelEnvelope } from '@kortix/shared';
import { and, eq } from 'drizzle-orm';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type ChannelModelScope,
  planChannelFollowUp,
  planChannelSessionStart,
  projectChannelModelScope,
} from '../model-access';
import { type ChannelSelection, type SettingsChannel, currentChannelSelection } from './settings';
import type { ChannelSessionPlan } from './conversation';
import { projectsView } from '../../workspaces/rows';

type ChatProject = { projectId: string; accountId: string; metadata: unknown };

/** The chat's settings row, only when it belongs to `projectId` (the row's key has no project). */
export async function chatSelection(settings: SettingsChannel, projectId: string): Promise<ChannelSelection | null> {
  const selection = await currentChannelSelection(settings);
  return selection?.projectId === projectId ? selection : null;
}

/** Shared keys only: no one's personal key or ChatGPT subscription. */
export function sharedChatScope(project: ChatProject): Promise<ChannelModelScope> {
  return projectChannelModelScope(project, { linkedUserId: null, oneToOne: false });
}

/**
 * The create body's agent and model. With no model choice it reads one row and plans nothing, so the
 * body is the one a chat with no settings sends. `unavailableModel`: the choice cannot run, and
 * nothing replaces it.
 */
export async function chatSessionStart(
  settings: SettingsChannel,
  project: ChatProject,
): Promise<{ agentName: string; model?: string; pools?: Record<string, string[]>; unavailableModel?: string }> {
  const selection = await chatSelection(settings, project.projectId);
  const agentName = selection?.agentName || 'default';
  if (!selection?.sessionModel) return { agentName };
  const scope = await sharedChatScope(project);
  const start = await planChannelSessionStart({
    projectId: project.projectId,
    accountId: project.accountId,
    userId: scope.memberUserId,
    scope,
    chosenModel: selection.sessionModel,
    agentName,
    // The core judges a first image against the body's model (conversation.ts `startModel`).
    hasImage: false,
  });
  return {
    agentName,
    ...(start.model ? { model: start.model } : {}),
    ...(start.pools ? { pools: start.pools } : {}),
    ...(start.unavailableModel ? { unavailableModel: start.unavailableModel } : {}),
  };
}

/**
 * The plan a new chat session starts with (a `ChannelMessage` `plan`): the
 * chat's choice with today's default fallback, or null — after
 * `onUnavailableModel` told the person in the platform's own words — when the
 * choice cannot run. The caller keeps its metadata block and its prompt.
 */
export async function chatSessionPlan(opts: {
  settings: SettingsChannel;
  project: ChannelSessionPlan['project'];
  /** The message's own text: the new session's title source; empty becomes null. */
  titleSource: string | null;
  metadata: Record<string, unknown>;
  prompt: ChannelEnvelope;
  /** Tells the person, in the platform's own words. */
  onUnavailableModel: (unavailableModel: string) => Promise<void>;
}): Promise<ChannelSessionPlan | null> {
  const start: Awaited<ReturnType<typeof chatSessionStart>> = await chatSessionStart(opts.settings, opts.project).catch((error) => {
    logger.warn(`[${opts.settings.platform}] chat settings unreadable; the session starts on the defaults`, {
      projectId: opts.project.projectId,
      error: String(error),
    });
    return { agentName: 'default' };
  });
  if (start.unavailableModel) {
    await opts.onUnavailableModel(start.unavailableModel);
    return null;
  }
  return {
    project: opts.project,
    visibility: 'project',
    body: {
      agent_name: start.agentName,
      ...(start.model ? { model: start.model } : {}),
      ...(start.pools ? { provider_secret_pools: start.pools } : {}),
      title_source: opts.titleSource || null,
    },
    metadata: opts.metadata,
    // A new session never asked the questions: the message alone.
    prompt: opts.prompt,
  };
}

/**
 * The model a follow-up into the chat's session runs on (a `ChannelPort.turnModel` body): the chat's
 * choice, else the session's pin, checked and replaced as the gateway runs it. Null when the chat
 * has no choice and the session no pin.
 */
export async function chatTurnModel(settings: SettingsChannel, thread: { sessionId: string; projectId: string }): Promise<string | null> {
  const [row] = await db
    .select({
      accountId: projectSessions.accountId,
      createdBy: projectSessions.createdBy,
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
      projectMetadata: projectsView.metadata,
    })
    .from(projectSessions)
    .innerJoin(projectsView, eq(projectsView.projectId, projectSessions.projectId))
    .where(and(eq(projectSessions.sessionId, thread.sessionId), eq(projectSessions.projectId, thread.projectId)))
    .limit(1);
  if (!row) return null;
  const pinned = (row.metadata as Record<string, unknown> | null)?.model;
  const pin = typeof pinned === 'string' && pinned.trim() ? pinned.trim() : null;
  const choice = (await chatSelection(settings, thread.projectId))?.sessionModel ?? null;
  if (!choice && !pin) return null;
  const scope = await sharedChatScope({ projectId: thread.projectId, accountId: row.accountId, metadata: row.projectMetadata });
  return planChannelFollowUp({
    projectId: thread.projectId,
    accountId: row.accountId,
    userId: row.createdBy ?? scope.memberUserId,
    scope,
    session: { sessionId: thread.sessionId, ownerUserId: row.createdBy, pinnedModel: pin },
    chosenModel: choice,
    hasImage: false,
  });
}

/**
 * The model the next message runs on: the conversation's `/model` choice —
 * it reaches the live session too — else the model the live session started
 * with (`pin`), else the project default. "project default" beside a session
 * pinned to another model was how a chat stuck on a model it could not run
 * looked fine.
 */
export function statusModel(choice: string | null, pin: string | null): string {
  if (choice) return labelForModelRef(choice);
  if (pin) return `${labelForModelRef(pin)} (this session)`;
  return 'workspace default';
}
