/**
 * Telegram as a channel connector. The webhook stores each
 * update in the integration event inbox; this consumer turns a stored message
 * into a session turn through the conversation core (channels/core/conversation.ts):
 *
 *   unknown sender  → a pairing reply naming their user id, no session (fail closed);
 *                     in a private chat, also an access request an admin can allow
 *   a command       → `/help` (`/start`), `/status`, `/new`, `/stop`, `/model`, `/agent`,
 *                     also as `/<verb>@<this bot>` and as a caption, run in the core
 *                     (core/commands.ts) and answered in the chat, with a menu of
 *                     buttons where the reply offers one; a caption's file is not read
 *   anything else   → the core: a follow-up into the chat's session, or a new
 *                     project-visible session bound to the chat; the message's own
 *                     file (photo, document, audio, voice, video) goes with it
 *   a button press  → a command button (`kc:`) on a menu Kortix sent runs its command
 *                     over the pressed message (core/commands.ts `runCommandPress`); a
 *                     question button answers the agent's question (core/questions.ts),
 *                     one question at a time; so does a message typed while one shows
 *
 * The agent answers through the `kortix_telegram` connector (connectors/channels.ts);
 * the bot token never enters the sandbox. The update shapes and the prompt
 * envelope live in ./events.ts; every message a person reads is rendered in
 * ./render.ts.
 */
import { chatThreads } from '@kortix/db';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { and, eq, like, or } from 'drizzle-orm';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { db } from '../../shared/db';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { gateSender, refusedPressText } from '../core/channel-access';
import { parseChannelCommand } from '../core/command-list';
import { isCommandPressData } from '../core/command-press';
import { type CommandReply, rememberCommandMenu, runChannelCommand, runCommandPress } from '../core/commands';
import { type ChannelMessage, type ChannelNotice, type ChannelPort, type ChannelTarget, routeChannelMessage } from '../core/conversation';
import { chatSessionPlan, chatTurnModel } from '../core/model-choice';
import {
  answerQuestionInChat,
  clearQuestionButtons,
  handleQuestionTap,
  type QuestionPort,
  questionPicksSoFar,
} from '../core/questions';
import { registerSessionPort } from '../core/session-notice';
import type { SettingsChannel } from '../core/settings';
import { claimThreadCreate, releaseThreadCreate, threadCreateClaim } from '../core/threads';
import { classifyTurnError } from '../slack/errors';
import { sessionWebUrl } from '../slack/util';
import { runErrorAdvice, startErrorMessage, TELEGRAM_START_ERROR_COMMANDS } from '../start-error';
import { telegramAccessPort } from './access';
import { TELEGRAM_UPDATES, telegramCall, telegramFile } from './api';
import { loadTelegramBotToken, loadTelegramInstall, loadTelegramWebhookSecret } from './installs';
import { repairTelegramMenu } from './menu';
import { type TelegramCallbackQuery, type TelegramMessage, telegramEnvelope, telegramThreadId } from './events';
import { type InlineButton, clip, inlineKeyboard, MAX_BUTTONS, questionBody, questionFooter, questionMessageText, telegramCommandMessage } from './render';
import { projectsView } from '../../workspaces/rows';

/** Telegram shows a spinner until a press is answered. Never throws. */
function answerPress(token: string, id: string, text = '', alert = false): Promise<unknown> {
  return telegramCall(token, 'answerCallbackQuery', {
    callback_query_id: id,
    ...(text ? { text: clip(text, 200) } : {}),
    ...(alert ? { show_alert: true } : {}),
  }).catch(() => undefined);
}

async function botToken(projectId: string): Promise<string> {
  const token = await loadTelegramBotToken(projectId);
  if (!token) throw new Error('telegram bot token missing');
  return token;
}

/**
 * The agent's questions (core/questions.ts), posted as the agent would post
 * them with `send_message`. A bot connected before buttons is subscribed to
 * presses first, once, as before its first menu; one that cannot be gets a
 * numbered list to reply to. A message ref is the Telegram message id.
 */
const telegramQuestions: QuestionPort = {
  maxButtons: MAX_BUTTONS,
  agentCall: (target, m) => ({ slug: TELEGRAM_CHANNEL_CONNECTOR_SLUG, actionPath: 'send_message', args: questionBody(target, m) }),
  async tapsReady(target) {
    const token = await loadTelegramBotToken(target.projectId);
    return !!token && ensureTelegramButtons(token, target.projectId, target.workspaceId);
  },
  async send(target, m) {
    const sent = await telegramCall<{ message_id: number }>(await botToken(target.projectId), 'sendMessage', questionBody(target, m));
    return String(sent.message_id);
  },
  async edit(target, ref, m) {
    // A number, as every reply sends it: only the post stands in for the agent's call.
    const message = { chat_id: Number(target.threadId.split(':')[0]), message_id: Number(ref) };
    const token = await botToken(target.projectId);
    await (m
      ? telegramCall(token, 'editMessageText', { ...message, text: questionMessageText(m), reply_markup: { inline_keyboard: inlineKeyboard(m) } })
      : telegramCall(token, 'editMessageReplyMarkup', { ...message, reply_markup: { inline_keyboard: [] } })
    ).catch((error) => {
      // A redraw of what the message already shows (a tap on an answered step).
      if (!String(error).includes('message is not modified')) throw error;
    });
  },
  async answerTap(tap, reply) {
    const token = await loadTelegramBotToken(tap.target.projectId).catch(() => null);
    if (token) await answerPress(token, tap.id, reply && questionFooter(reply));
  },
  threadOfTap: (tap, sessionId) => telegramThreadOfSession(sessionId, tap.target.workspaceId, tap.target.threadId.split(':')[0]!),
};

/** The chat's settings row key (`chat_channel_bindings`): the chat, so a forum's topics share one. */
const telegramSettings = (target: ChannelTarget): SettingsChannel => ({
  platform: 'telegram',
  teamId: target.workspaceId,
  channelId: target.threadId.split(':')[0]!,
});

export const telegramPort: ChannelPort & { questions: QuestionPort } = {
  async notify(target, notice) {
    const text = telegramNotice(target, notice);
    if (!text) return;
    const token = await loadTelegramBotToken(target.projectId);
    if (token) await sendTelegramReply(token, target, text);
  },
  questions: telegramQuestions,
  turnModel: (target, thread) => chatTurnModel(telegramSettings(target), thread),
};

/**
 * Buttons answer through `callback_query` updates. A bot connected before
 * buttons gets messages only: subscribe it once, on its own URL with its own
 * secret, keeping the updates Telegram still holds. Only this project's webhook:
 * one bot can be installed in several projects, and re-pointing another
 * project's webhook with this project's secret would deafen it. False: post text.
 */
async function subscribeToButtons(token: string, projectId: string): Promise<boolean> {
  try {
    const info = await telegramCall<{ url?: string; allowed_updates?: string[] }>(token, 'getWebhookInfo');
    if (!info.url?.endsWith(`/v1/webhooks/telegram/${projectId}`)) return false;
    // Absent: Telegram's default set, which carries callback_query.
    if (!info.allowed_updates || info.allowed_updates.includes('callback_query')) return true;
    const secret = await loadTelegramWebhookSecret(projectId);
    if (!secret) return false;
    await telegramCall(token, 'setWebhook', { url: info.url, secret_token: secret, allowed_updates: TELEGRAM_UPDATES });
    logger.info('[telegram] bot subscribed to button presses', { projectId });
    return true;
  } catch (error) {
    logger.warn('[telegram] button subscription failed; the question is posted as text', { projectId, error: String(error) });
    return false;
  }
}

/** The chat's words for a notice; null says nothing. */
export function telegramNotice(target: ChannelTarget, notice: ChannelNotice): string | null {
  switch (notice.kind) {
    case 'create_pending':
      return 'Kortix is still starting a session for this chat. The agent replies here when it is ready.';
    case 'create_in_flight':
      return 'Kortix is still starting a session for this chat. Send your message again in a minute.';
    case 'create_failed':
      return startErrorMessage(notice.error.status, notice.error.body, TELEGRAM_START_ERROR_COMMANDS);
    case 'follow_up_failed':
      return "This chat's Kortix session cannot take new messages. Send /new to start a new conversation, then send your message again.";
    case 'run_failed': {
      const { title, aborted } = classifyTurnError(notice.error);
      // A stop is not a failure; the push skips it too (notifications/session-push.ts).
      if (aborted) return null;
      // The title comes from a closed set: the provider's own message never reaches the chat.
      return [
        `Kortix could not finish this run: ${title}.`,
        runErrorAdvice(title, TELEGRAM_START_ERROR_COMMANDS),
        `Details: ${sessionWebUrl(config.FRONTEND_URL, target.projectId, notice.sessionId)}`,
      ].join('\n');
    }
    case 'start_retrying':
      return [
        `Kortix could not start this chat's session yet. ${notice.reason}`,
        'Kortix tries again automatically for a few minutes. If the agent does not reply, send /new, then send your message again.',
      ].join('\n');
    case 'start_failed':
      return [
        `Kortix could not start this chat's session, so the agent did not run.${notice.reason ? ` ${notice.reason}` : ''}`,
        'Send /new, then send your message again. If it fails again, a workspace admin can check the session in Kortix.',
        `Details: ${sessionWebUrl(config.FRONTEND_URL, target.projectId, notice.sessionId)}`,
      ].join('\n');
  }
}

export async function handleTelegramEvent(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const message = event.data.message as unknown as TelegramMessage;
  const [project] = await db.select().from(projectsView).where(eq(projectsView.projectId, event.projectId)).limit(1);
  if (!project) return;
  const [install, token] = await Promise.all([
    loadTelegramInstall(event.projectId),
    loadTelegramBotToken(event.projectId),
  ]);
  if (!install || !token) return;

  const text = (message.text ?? message.caption ?? '').trim();
  const senderId = message.from?.id == null ? '' : String(message.from.id);
  const target: ChannelTarget = {
    platform: 'telegram',
    workspaceId: install.botId,
    threadId: telegramThreadId(message),
    projectId: event.projectId,
    messageId: String(message.message_id),
  };
  const reply = (body: string) => sendTelegramReply(token, target, body);

  const refusal = await gateSender(telegramAccessPort, {
    projectId: event.projectId,
    scopeId: install.botId,
    lists: install,
    senderId,
    direct: message.chat.type === 'private',
    from: message.from,
  });
  if (refusal) {
    await reply(refusal);
    return;
  }
  await repairTelegramMenu(token, install.botId);
  const createClaim = threadCreateClaim('telegram', event.projectId, install.botId, target.threadId);
  const file = telegramFileOf(message);
  const command = parseChannelCommand(text, install.username);
  if (command) {
    await runChannelCommand(
      {
        target,
        project,
        settings: telegramSettings(target),
        label: { name: telegramChatName(message.chat), type: message.chat.type },
        createClaim,
        questions: telegramQuestions,
        ...(file ? { droppedFile: file.kind } : {}),
      },
      command,
      async (body) => {
        const m = telegramCommandMessage(body);
        if (m.keyboard.length) await ensureTelegramButtons(token, event.projectId, install.botId);
        const sent = await sendTelegramReply(token, target, clip(m.text, CHANNELS.telegram.messageChars), m.keyboard);
        if (sent !== null && m.keyboard.length) await rememberCommandMenu(target, String(sent));
      },
    );
    return;
  }
  // A question shown one at a time takes a typed answer; a message with a file is never one.
  if (!file && (await answerQuestionInChat(telegramPort, target, { id: `message:${event.id}`, text }, answerFollowUp(event, install.botId, message, message.from), run))) {
    return;
  }
  // The message carries the answers given so far on a question it ends. Read
  // before it routes and cleared after, so a retry carries them again.
  const picks = await questionPicksSoFar(target);
  const envelope = telegramEnvelope(message);

  await telegramCall(token, 'sendChatAction', {
    chat_id: message.chat.id,
    action: 'typing',
    ...(message.is_topic_message ? { message_thread_id: message.message_thread_id } : {}),
  }).catch(() => undefined);

  await routeChannelMessage(
    telegramPort,
    {
      target,
      keys: {
        followUp: `telegram:${install.botId}:${event.id}`,
        create: `telegram:create:${install.botId}:${event.id}`,
        createClaim,
      },
      followUp: picks ? { ...envelope, text: `${picks}\n\n${envelope.text}` } : envelope,
      files: file
        ? [{
            kind: file.kind,
            ...(file.name ? { name: file.name } : {}),
            mime: file.mime,
            ...(file.ref.file_size ? { size: file.ref.file_size } : {}),
            read: (maxBytes) => telegramFile(token, file.ref.file_id, maxBytes),
          }]
        : [],
      plan: () =>
        chatSessionPlan({
          settings: telegramSettings(target),
          project,
          titleSource: text,
          metadata: {
            telegram: {
              bot_id: install.botId,
              chat_id: message.chat.id,
              chat_type: message.chat.type,
              from_id: message.from?.id,
              message_id: message.message_id,
            },
          },
          prompt: envelope,
          onUnavailableModel: (model) =>
            reply(`Kortix did not send your message: this chat's model ${model} is not available any more. Pick another with /model, then send your message again.`),
        }),
    },
    run,
  );
  await clearQuestionButtons(telegramQuestions, target, 'answered_in_chat');
}

/**
 * A tap on an inline button. From an allowed user, a command button (`kc:`)
 * runs its command over the pressed message (`handleTelegramCommandPress`), and
 * a question button answers the question (core/questions.ts `handleQuestionTap`).
 * A tap from anyone else answers nothing.
 */
export async function handleTelegramPress(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  const press = event.data.callback_query as unknown as TelegramCallbackQuery;
  const [install, token] = await Promise.all([loadTelegramInstall(event.projectId), loadTelegramBotToken(event.projectId)]);
  if (!install || !token) return;

  // The same gate as a typed message. An alert, never a chat message: in a group
  // the pairing reply would reach everyone.
  if (!install.allowedUserIds.includes(String(press.from.id))) {
    await answerPress(token, press.id, refusedPressText(telegramAccessPort, String(press.from.id)), true);
    return;
  }
  const message = press.message;
  // No message to answer in (an inline-mode press, which Kortix never asks for).
  if (!message) return void (await answerPress(token, press.id));
  if (isCommandPressData(press.data ?? '')) return handleTelegramCommandPress(event, install.botId, token, press, message);
  const ref = String(message.message_id);
  await handleQuestionTap(
    telegramPort,
    {
      target: { platform: 'telegram', workspaceId: install.botId, threadId: telegramThreadId(message), projectId: event.projectId, messageId: ref },
      ref,
      data: press.data ?? '',
      id: press.id,
    },
    answerFollowUp(event, install.botId, message, press.from),
    run,
  );
}

/** An answer to the agent's question, as a follow-up under the key of the update (a press or a typed message) that gave it. */
function answerFollowUp(
  event: IntegrationEvent,
  botId: string,
  message: Pick<TelegramMessage, 'message_id' | 'chat'>,
  from: TelegramMessage['from'],
): (threadId: string, answer: string) => Pick<ChannelMessage, 'keys' | 'followUp'> {
  return (threadId, answer) => {
    const [, topicId] = threadId.split(':');
    const reply: TelegramMessage = {
      message_id: message.message_id,
      chat: message.chat,
      from,
      text: answer,
      ...(topicId ? { is_topic_message: true, message_thread_id: Number(topicId) } : {}),
    };
    return {
      keys: {
        followUp: `telegram:${botId}:${event.id}`,
        create: `telegram:create:${botId}:${event.id}`,
        createClaim: threadCreateClaim('telegram', event.projectId, botId, threadId),
      },
      followUp: telegramEnvelope(reply),
    };
  };
}

/** A tap on a command button: the core runs it in the pressed message's chat and topic (core/commands.ts `runCommandPress`). */
async function handleTelegramCommandPress(
  event: IntegrationEvent,
  botId: string,
  token: string,
  press: TelegramCallbackQuery,
  message: NonNullable<TelegramCallbackQuery['message']>,
): Promise<void> {
  const [project] = await db.select().from(projectsView).where(eq(projectsView.projectId, event.projectId)).limit(1);
  if (!project) return void (await answerPress(token, press.id));
  const target: ChannelTarget = {
    platform: 'telegram',
    workspaceId: botId,
    threadId: telegramThreadId(message),
    projectId: event.projectId,
    messageId: String(message.message_id),
  };
  await runCommandPress(
    {
      target,
      project,
      settings: telegramSettings(target),
      // The stored press keeps no chat names (telegramPressEvent): a row this press creates asks Telegram.
      label: { name: null, type: message.chat.type, lookupName: () => fetchTelegramChatName(token, message.chat.id) },
      createClaim: threadCreateClaim('telegram', event.projectId, botId, target.threadId),
      questions: telegramQuestions,
    },
    press.data!,
    (reply) => editTelegramCommand(token, message, reply),
    async (text) => void (await answerPress(token, press.id, text)),
  );
}

/** Draw a command reply over the pressed message. An unchanged page ("message is not modified") is not logged. */
async function editTelegramCommand(token: string, message: { message_id: number; chat: { id: number } }, reply: CommandReply): Promise<void> {
  const m = telegramCommandMessage(reply);
  await telegramCall(token, 'editMessageText', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: clip(m.text, CHANNELS.telegram.messageChars),
    // Empty: the buttons go.
    reply_markup: { inline_keyboard: m.keyboard },
  }).catch((error) => {
    // ponytail: a refused edit (message deleted or too old) leaves the menu; send the reply as a new message if that matters.
    if (!String(error).includes('message is not modified')) logger.warn('[telegram] command reply not drawn', { error: String(error) });
  });
}

/** The session's thread in this chat (the chat itself, or one of its forum topics), on this bot. */
async function telegramThreadOfSession(sessionId: string, botId: string, chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: chatThreads.threadId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'telegram'),
        eq(chatThreads.platformTeamId, botId),
        eq(chatThreads.sessionId, sessionId),
        or(eq(chatThreads.threadId, chatId), like(chatThreads.threadId, `${chatId}:%`)),
      ),
    )
    .limit(1);
  return row?.threadId ?? null;
}

/**
 * Once per bot, before its first menu or question: a bot connected before
 * #10994 (2026-10-28) receives messages only (`allowed_updates: ['message']`),
 * so its buttons would never answer. Not subscribed: false, the claim goes, and
 * the next menu or question tries again.
 */
async function ensureTelegramButtons(token: string, projectId: string, botId: string): Promise<boolean> {
  const key = `telegram:buttons:${botId}`;
  const claim = await claimThreadCreate(key, 365 * 24 * 60 * 60_000).catch(() => null);
  if (!claim || (await subscribeToButtons(token, projectId))) return true;
  await releaseThreadCreate(key, claim).catch(() => undefined);
  return false;
}

/** What the Kortix Channels page calls a chat: its title, else the @username or the first name of a private chat. */
function telegramChatName(chat: TelegramMessage['chat']): string | null {
  return chat.title || (chat.username ? `@${chat.username}` : chat.first_name) || null;
}

/** A chat's name from `getChat`, within 3 s. Null when Telegram does not answer or refuses: the row goes unnamed. */
async function fetchTelegramChatName(token: string, chatId: number): Promise<string | null> {
  const chat = await telegramCall<TelegramMessage['chat']>(token, 'getChat', { chat_id: chatId }, 3_000).catch(() => null);
  return chat && telegramChatName(chat);
}

/**
 * One reply path for commands and notices: the chat and topic come from the
 * target's thread id. A target found from a session has no message to answer,
 * so its notice is posted unanchored. Returns the sent message's id; null when
 * Telegram refused it (logged).
 */
async function sendTelegramReply(token: string, target: ChannelTarget, text: string, keyboard: InlineButton[][] = []): Promise<number | null> {
  const [chatId, topicId] = target.threadId.split(':');
  return telegramCall<{ message_id: number }>(token, 'sendMessage', {
    chat_id: Number(chatId),
    text,
    ...(target.messageId
      ? { reply_parameters: { message_id: Number(target.messageId), allow_sending_without_reply: true } }
      : {}),
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  }).then(
    (sent) => sent.message_id,
    (error) => {
      logger.warn('[telegram] reply failed', { error: String(error) });
      return null;
    },
  );
}

// One queue for every Telegram update: a replica on older code fails a press
// (it has no message), and the retry reaches a replica that knows it. And one
// order per chat or forum topic: a message and a button press run in
// Telegram's update order (event-inbox.ts `sequence`).
registerEventConsumer('telegram.', (event, run) =>
  event.type === TELEGRAM_PRESS_EVENT ? handleTelegramPress(event, run) : handleTelegramEvent(event, run));
registerSessionPort('telegram', telegramPort);
