import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChannelEnvelope } from '@kortix/shared';

// Characterization test (KRTX-4562): pins chatSessionPlan's contract before
// the Telegram and Discord adapters give up their own copies of the plan
// assembly. The settings read is mocked one layer down (currentChannelSelection);
// the model planning one layer further (model-access), so no database runs.

let selection: Record<string, unknown> | null = null;
let selectionThrows: unknown = null;
mock.module('./settings', () => ({
  currentChannelSelection: async () => {
    if (selectionThrows) throw selectionThrows;
    return selection;
  },
}));

const planned: Array<Record<string, unknown>> = [];
let planResult: Record<string, unknown> = {};
mock.module('../model-access', () => ({
  projectChannelModelScope: async () => ({ memberUserId: 'ivan' }),
  planChannelSessionStart: async (input: Record<string, unknown>) => {
    planned.push(input);
    return planResult;
  },
  planChannelFollowUp: async () => null,
}));

const { chatSessionPlan } = await import('./model-choice');

const settings = { platform: 'telegram', teamId: 'bot-1', channelId: 'chat-1' };
// The rows the adapters pass through; only the fields the plan reads.
const project = { projectId: 'p1', accountId: 'a1', metadata: {} } as Parameters<typeof chatSessionPlan>[0]['project'];
const prompt: ChannelEnvelope = {
  platform: 'Telegram',
  sender: '@synthetic_user',
  where: 'chat',
  text: 'status?',
  reply: 'kortix connectors call kortix_telegram.send_message …',
  notes: [],
};

beforeEach(() => {
  selection = null;
  selectionThrows = null;
  planned.length = 0;
  planResult = {};
});

describe('chatSessionPlan — the plan a new chat session starts with', () => {
  test('a settings read that throws starts on the defaults, and the session still starts', async () => {
    selectionThrows = new Error('connection refused');

    const plan = await chatSessionPlan({
      settings, project, titleSource: 'hello', metadata: { telegram: { chat_id: 7 } }, prompt,
      onUnavailableModel: async () => expect.unreachable(),
    });

    expect(plan?.body).toEqual({ agent_name: 'default', title_source: 'hello' });
    expect(plan?.project).toBe(project);
    expect(plan?.visibility).toBe('project');
    expect(plan?.metadata).toEqual({ telegram: { chat_id: 7 } });
    expect(plan?.prompt).toBe(prompt);
  });

  test('an unavailable model calls the notice and yields null: no session starts', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', sessionModel: 'kortix/gone' };
    planResult = { model: 'kortix/gone', unavailableModel: 'kortix/gone' };
    const told: string[] = [];

    const plan = await chatSessionPlan({
      settings, project, titleSource: 'hello', metadata: {}, prompt,
      onUnavailableModel: async (model) => {
        told.push(model);
      },
    });

    expect(plan).toBeNull();
    expect(told).toEqual(['kortix/gone']);
  });

  test('a good read maps the agent, the model and its key pools into the body', async () => {
    selection = { projectId: 'p1', agentName: 'reviewer', sessionModel: 'codex/gpt-6-astra' };
    planResult = { agentName: 'reviewer', model: 'codex/gpt-6-astra', pools: { codex: ['k1', 'k2'] } };

    const plan = await chatSessionPlan({
      settings, project, titleSource: '', metadata: { discord: { channel_id: 'c1' } }, prompt,
      onUnavailableModel: async () => expect.unreachable(),
    });

    expect(plan?.body).toEqual({
      agent_name: 'reviewer',
      model: 'codex/gpt-6-astra',
      provider_secret_pools: { codex: ['k1', 'k2'] },
      title_source: null,
    });
    // The read goes through the shared scope: no one's personal key or
    // ChatGPT subscription reaches a chat everyone shares.
    expect(planned[0]).toMatchObject({ projectId: 'p1', accountId: 'a1', agentName: 'reviewer', hasImage: false });
  });
});
