import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import type { TurnErrorInfo } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { discordNotice } from './session';

// Characterization test (KRTX-4562): pins discordNotice's wording before the
// run-error advice table moves into start-error.ts. The wording must not
// change — Discord says "Use /new" where Telegram says "Send /new".

describe('discord notices for a conversation (run errors)', () => {
  const target = { platform: 'discord' as const, workspaceId: '555', threadId: '1', projectId: 'p1' };
  const details = `Details: ${sessionWebUrl(config.FRONTEND_URL, 'p1', 's1')}`;
  const runFailed = (error?: TurnErrorInfo) => discordNotice(target, { kind: 'run_failed', sessionId: 's1', error });

  const cases: Array<[TurnErrorInfo | undefined, string, string]> = [
    [{ name: 'APIError', statusCode: 402, message: 'Payment Required: Insufficient credits. Balance: -6 credits' }, 'Out of credits', 'A workspace admin can top up credits in Kortix. Then send your message again.'],
    [{ name: 'APIError', statusCode: 429, message: 'rate limited' }, 'Usage limit reached', 'Wait, then send your message again. A workspace admin can also pick another model in Kortix.'],
    [{ name: 'MessageOutputLengthError', message: '' }, 'Response too long', 'Ask the agent to continue, or narrow the request.'],
    [{ name: 'ContextOverflowError', message: '' }, 'Conversation too long', 'Use /new to start a new conversation.'],
    [{ name: 'UnknownError', message: 'agent "reviewer" not found' }, 'Agent unavailable', 'Use /agent to pick another agent, then /new and your message again. A workspace admin can also fix the agent in Kortix.'],
    [{ name: 'APIError', statusCode: 404, message: 'model gone' }, 'Model unavailable', 'Use /model to pick another model, then send your message again.'],
    [{ name: 'APIError', statusCode: 503, message: 'upstream unavailable' }, 'Provider unavailable', 'Send your message again to retry.'],
    [{ name: 'UnknownError', message: 'boom' }, 'Run failed', 'Send your message again, or use /new to start a new conversation.'],
    [undefined, 'Run failed', 'Send your message again, or use /new to start a new conversation.'],
  ];
  for (const [error, title, advice] of cases) {
    test(`${title}: the title, what to do next and the session link, never the provider's text`, () => {
      expect(runFailed(error)).toBe([`Kortix could not finish this run: ${title}.`, advice, details].join('\n'));
      if (error?.message) expect(runFailed(error)).not.toContain(error.message);
    });
  }

  test('advice that points at a command says "Use", not Telegram\'s "Send"', () => {
    expect(runFailed({ name: 'ContextOverflowError', message: '' })).toContain('Use /new');
    expect(runFailed({ name: 'ContextOverflowError', message: '' })).not.toContain('Send /new');
    expect(runFailed({ name: 'APIError', statusCode: 402, message: 'credits' })).not.toContain('Use /new');
  });

  test('a stopped run says nothing', () => {
    expect(runFailed({ name: 'MessageAbortedError', message: '' })).toBeNull();
    expect(runFailed({ name: 'Error', message: '', code: 'aborted' })).toBeNull();
  });

  test('a failed start says so, with the classified reason when there is one, and asks for /new', () => {
    const reason = "Couldn't access the project's Git repository. Check the project's Git credentials and try again.";
    const tail = ['Use /new, then send your message again. If it fails again, a workspace admin can check the session in Kortix.', details];
    expect(discordNotice(target, { kind: 'start_failed', sessionId: 's1', reason })).toBe(
      [`Kortix could not start this conversation's session, so the agent did not run. ${reason}`, ...tail].join('\n'),
    );
    expect(discordNotice(target, { kind: 'start_failed', sessionId: 's1', reason: null })).toBe(
      ["Kortix could not start this conversation's session, so the agent did not run.", ...tail].join('\n'),
    );
  });

  test('a start the provider may clear says it is retrying, and when to use /new', () => {
    const reason = 'The compute provider is at capacity right now.';
    expect(discordNotice(target, { kind: 'start_retrying', sessionId: 's1', reason })).toBe(
      [
        `Kortix could not start this conversation's session yet. ${reason}`,
        'Kortix tries again automatically for a few minutes. If the agent does not reply, use /new, then send your message again.',
      ].join('\n'),
    );
  });

  test('the inbound notices keep their copy', () => {
    expect(discordNotice(target, { kind: 'create_pending' })).toBe('Kortix is still starting a session for this conversation. The agent replies here when it is ready.');
    expect(discordNotice(target, { kind: 'create_in_flight' })).toBe('Kortix is still starting a session for this conversation. Send your message again in a minute.');
    expect(discordNotice(target, { kind: 'follow_up_failed' })).toBe("This conversation's Kortix session cannot take new messages. Use /new to start a new conversation, then send your message again.");
  });
});
