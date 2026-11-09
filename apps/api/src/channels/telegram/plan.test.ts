import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChannelEnvelope } from '@kortix/shared';
import type { ChannelMessage, ChannelSessionPlan } from '../core/conversation';
import type { IntegrationEvent } from '../../integrations/event-inbox';

// Characterization test (KRTX-4562): pins the plan a new Telegram chat session
// starts with at the adapter boundary — the `plan` thunk `handleTelegramEvent`
// hands to `routeChannelMessage` — before and after the plan assembly moves
// into core/model-choice.ts `chatSessionPlan`. The prior inline behavior must
// not change: a settings read that throws starts on the defaults, an
// unavailable model tells the person and starts nothing, and a good read maps
// the choice into the body with the chat's own settings key, metadata block
// and prompt. The handler is mocked one layer out (the router, the installs,
// the Telegram API); the settings read and the model planning are mocked one
// layer in (core/settings, model-access), so no database runs.

// The row the handler reads; only the fields the plan reads.
const project = {
  projectId: 'p1',
  accountId: 'a1',
  metadata: {},
} as ChannelSessionPlan['project'];

let selection: Record<string, unknown> | null = null;
let selectionThrows: unknown = null;
const selectionKeys: Array<Record<string, unknown>> = [];
mock.module('../core/settings', () => ({
  currentChannelSelection: async (key: Record<string, unknown>) => {
    selectionKeys.push(key);
    if (selectionThrows) throw selectionThrows;
    return selection;
  },
  // Command-flow writes; none runs in a plan.
  ensureChatBinding: async () => undefined,
  setChannelAgent: async () => undefined,
  setChannelModel: async () => undefined,
}));

const planned: Array<Record<string, unknown>> = [];
let planResult: Record<string, unknown> = {};
mock.module('../model-access', () => ({
  applyChannelSessionKeys: async () => undefined,
  checkChannelModel: async () => null,
  listChannelModels: async () => ({ models: [] }),
  planChannelFollowUp: async () => null,
  planChannelSessionStart: async (input: Record<string, unknown>) => {
    planned.push(input);
    return planResult;
  },
  projectChannelModelScope: async () => ({ memberUserId: 'ivan' }),
}));

const routed: ChannelMessage[] = [];
mock.module('../core/conversation', () => ({
  routeChannelMessage: async (_port: unknown, message: ChannelMessage) => {
    routed.push(message);
  },
  forgetChatThread: async () => undefined,
}));

mock.module('../core/channel-access', () => ({
  gateSender: async () => null,
  refusedPressText: () => '',
  cleanName: (value: string) => value,
}));

mock.module('../core/questions', () => ({
  answerQuestionInChat: async () => false,
  clearQuestionButtons: async () => undefined,
  handleQuestionTap: async () => undefined,
  questionPicksSoFar: async () => null,
}));

const sent: Array<{ method: string; args: Record<string, unknown> }> = [];
mock.module('./api', () => ({
  TELEGRAM_UPDATES: [],
  telegramCall: async (_token: string, method: string, args: Record<string, unknown>) => {
    sent.push({ method, args });
    return { message_id: 8, ok: true };
  },
  telegramFile: async () => new Uint8Array(),
  telegramDownload: async () => new Uint8Array(),
  telegramUnreachable: () => null,
}));

mock.module('./installs', () => ({
  TELEGRAM_USER_ID: 'telegram-user',
  loadTelegramBotToken: async () => 'bot-token',
  loadTelegramInstall: async () => ({
    botId: 'bot-1',
    username: 'kortix_bot',
    allowedUserIds: ['42'],
    accessRequests: [],
  }),
  loadTelegramWebhookSecret: async () => 'secret',
  telegramRequester: async () => null,
}));

mock.module('./menu', () => ({
  repairTelegramMenu: async () => undefined,
}));

// commands.ts pulls the provisioning surface for its /stop flow; none of it
// runs in a plan. Mock it so its import graph (the discord install store)
// never loads.
mock.module('../../projects/surface', () => ({
  PROVISIONING_SESSION_STATUSES: ['starting'],
  abortRuntimeTurn: async () => false,
  readRunningTurn: async () => null,
  savedProjectConfig: async () => null,
}));

let dbResults: unknown[][] = [];
const where: unknown[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'limit', 'set', 'values', 'returning', 'onConflictDoUpdate']) chain[m] = () => chain;
  chain.where = (w: unknown) => {
    where.push(w);
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

const { handleTelegramEvent } = await import('./session');

const message = {
  message_id: 7,
  date: 1_760_000_000,
  chat: { id: -100123, type: 'supergroup' },
  from: { id: 42, username: 'synthetic_user' },
  text: 'status?',
};

const event = (): IntegrationEvent =>
  ({
    id: '9',
    source: 'telegram:555',
    type: 'telegram.message.created',
    time: new Date(1_760_000_000_000).toISOString(),
    subject: '-100123',
    sequence: 9,
    projectId: 'p1',
    data: { message },
  }) as unknown as IntegrationEvent;

beforeEach(() => {
  selection = null;
  selectionThrows = null;
  selectionKeys.length = 0;
  planned.length = 0;
  planResult = {};
  routed.length = 0;
  sent.length = 0;
  where.length = 0;
  dbResults = [[project]];
});

async function planOf(): Promise<ReturnType<ChannelMessage['plan']>> {
  await handleTelegramEvent(event());
  expect(routed).toHaveLength(1);
  return routed[0]!.plan();
}

describe('the plan a new Telegram chat session starts with (the adapter boundary)', () => {
  test('the chat reads its settings under the Telegram key: the chat, so a forum shares one', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', sessionModel: 'codex/gpt-6-astra' };
    planResult = { agentName: 'reviewer', model: 'codex/gpt-6-astra' };

    await planOf();

    expect(selectionKeys).toEqual([{ platform: 'telegram', teamId: 'bot-1', channelId: '-100123' }]);
  });

  test('a settings read that throws starts on the defaults, and the session still starts', async () => {
    selectionThrows = new Error('connection refused');

    const plan = (await planOf())!;

    expect(plan.body).toEqual({ agent_name: 'default', title_source: 'status?' });
    expect(plan.project).toBe(project);
    expect(plan.visibility).toBe('project');
    // The platform block rides along: the session is bound back to this chat.
    expect(plan.metadata).toEqual({
      telegram: { bot_id: 'bot-1', chat_id: -100123, chat_type: 'supergroup', from_id: 42, message_id: 7 },
    });
    // A new session never asked the questions: the message alone.
    expect(plan.prompt).toMatchObject({ platform: 'Telegram', sender: '@synthetic_user', where: 'chat -100123', text: 'status?' });
    expect(sent.map((s) => s.method)).toEqual(['sendChatAction']);
  });

  test('an unavailable model tells the person in this chat and starts nothing', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', sessionModel: 'kortix/gone' };
    planResult = { model: 'kortix/gone', unavailableModel: 'kortix/gone' };

    const plan = await planOf();

    expect(plan).toBeNull();
    const told = sent.filter((s) => s.method === 'sendMessage');
    expect(told).toHaveLength(1);
    expect(told[0]!.args).toMatchObject({
      chat_id: -100123,
      text: "Kortix did not send your message: this chat's model kortix/gone is not available any more. Pick another with /model, then send your message again.",
      reply_parameters: { message_id: 7 },
    });
  });

  test('a good read maps the agent, the model and its key pools into the body, planned through the shared scope', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', sessionModel: 'codex/gpt-6-astra' };
    planResult = { agentName: 'reviewer', model: 'codex/gpt-6-astra', pools: { codex: ['k1', 'k2'] } };

    const plan = (await planOf())!;

    expect(plan.body).toEqual({
      agent_name: 'reviewer',
      model: 'codex/gpt-6-astra',
      provider_secret_pools: { codex: ['k1', 'k2'] },
      title_source: 'status?',
    });
    // The read goes through the shared scope: no one's personal key or
    // ChatGPT subscription reaches a chat everyone shares.
    expect(planned[0]).toMatchObject({
      projectId: 'p1',
      accountId: 'a1',
      userId: 'ivan',
      agentName: 'reviewer',
      chosenModel: 'codex/gpt-6-astra',
      hasImage: false,
    });
  });
});
