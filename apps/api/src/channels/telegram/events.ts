/**
 * What Telegram sends, and what the agent reads: the update shapes
 * (`TelegramMessage`, `TelegramCallbackQuery`, `TelegramUpdate`), the inbox
 * envelopes for a message and a button press, and the prompt envelope
 * (`telegramEnvelope`) the core renders. Pure: no network, no database.
 */
import type { ChannelEnvelope } from '@kortix/shared';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { TELEGRAM_CHANNEL_CONNECTOR_SLUG } from '../../connectors/channels';
import { type IntegrationEvent } from '../../integrations/event-inbox';
import { kortixCommandsSentence } from '../core/command-list';
import { connectorReply } from '../core/prompt';

export const TELEGRAM_MESSAGE_EVENT = 'telegram.message.created';

/** A file a message carries: the id `getFile` takes, and what Telegram states about it. */
interface TelegramFileRef { file_id: string; file_size?: number; file_name?: string; mime_type?: string; duration?: number }

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
  from?: { id?: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  photo?: Array<TelegramFileRef & { width: number; height: number }>;
  /** Also set for an animation, so an animation is read once, as this. */
  document?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
  video?: TelegramFileRef;
  video_note?: TelegramFileRef;
  sticker?: { emoji?: string };
  media_group_id?: string;
}

/** Each kind of file, in the order read: Kortix's word for it (also the session-view label) and the type Telegram leaves out. */
const TELEGRAM_FILE_KINDS = [
  { kind: 'photo', noun: 'photo', mime: 'image/jpeg' },
  { kind: 'document', noun: 'document', mime: 'application/octet-stream' },
  { kind: 'audio', noun: 'audio', mime: 'audio/mpeg' },
  { kind: 'voice', noun: 'voice message', mime: 'audio/ogg' },
  { kind: 'video', noun: 'video', mime: 'video/mp4' },
  { kind: 'video_note', noun: 'video message', mime: 'video/mp4' },
] as const;

/**
 * The message's own file, never a quoted message's (`reply_to_message`). A photo comes in several
 * sizes: the largest by area, since the Bot API does not state their order. Null: no file.
 */
export function telegramFileOf(
  message: TelegramMessage,
): { ref: TelegramFileRef; kind: string; name?: string; mime: string; label: string } | null {
  for (const k of TELEGRAM_FILE_KINDS) {
    const value = message[k.kind];
    const ref = Array.isArray(value)
      ? value.reduce<(typeof value)[number] | undefined>((best, size) => (!best || size.width * size.height > best.width * best.height ? size : best), undefined)
      : value;
    if (!ref?.file_id) continue;
    const label = k.kind === 'document' && ref.file_name ? `file ${ref.file_name}`
      : ref.duration && (k.kind === 'voice' || k.kind === 'video_note') ? `${k.noun}, ${ref.duration} s`
      : k.noun;
    return { ref, kind: k.noun, ...(ref.file_name ? { name: ref.file_name } : {}), mime: ref.mime_type || k.mime, label };
  }
  return null;
}

/**
 * The sender's words: the text, else the caption, else a label for the file or sticker. A named file keeps
 * its label under a caption, so its name reaches the agent in the sender's own (untrusted) text.
 */
function telegramText(message: TelegramMessage): string {
  if (message.text !== undefined) return message.text;
  const file = telegramFileOf(message);
  if (message.caption !== undefined) return file?.name ? `${message.caption}\n(${file.label})` : message.caption;
  if (file) return `(${file.label})`;
  if (message.sticker) return message.sticker.emoji ? `(sticker ${message.sticker.emoji})` : '(sticker)';
  return '(no text)';
}

/** A tap on an inline button. */
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  /** The message with the button. Absent for an inline-mode message, which Kortix never sends. */
  message?: Pick<TelegramMessage, 'message_id' | 'chat' | 'message_thread_id' | 'is_topic_message'>;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** A forum topic is its own conversation; otherwise the whole chat is one. */
export function telegramThreadId(message: TelegramMessage): string {
  return message.is_topic_message && message.message_thread_id
    ? `${message.chat.id}:${message.message_thread_id}`
    : String(message.chat.id);
}

/**
 * The inbox envelope for an update, or null when it carries nothing to answer. Edits are skipped, and so
 * is a message with no text, caption, file or sticker: a join, a pin, a location, a contact or a poll.
 */
export function telegramMessageEvent(
  projectId: string,
  botId: string,
  update: TelegramUpdate,
): IntegrationEvent | null {
  const message = update.message;
  if (!message?.chat || message.from?.is_bot) return null;
  if (message.text === undefined && message.caption === undefined && !message.sticker && !telegramFileOf(message)) return null;
  return {
    id: String(update.update_id),
    source: `telegram:${botId}`,
    type: TELEGRAM_MESSAGE_EVENT,
    time: new Date((message.date ?? Date.now() / 1000) * 1000).toISOString(),
    subject: telegramThreadId(message),
    sequence: update.update_id,
    projectId,
    data: { message: message as unknown as Record<string, unknown> },
  };
}

export const TELEGRAM_PRESS_EVENT = 'telegram.callback_query.created';

/** The inbox envelope for a button press, or null for an update without one. */
export function telegramPressEvent(projectId: string, botId: string, update: TelegramUpdate): IntegrationEvent | null {
  const press = update.callback_query;
  if (!press?.id || !press.from) return null;
  const message = press.message;
  const stored: TelegramCallbackQuery = {
    id: press.id,
    from: { id: press.from.id, ...(press.from.username ? { username: press.from.username } : {}) },
    ...(press.data ? { data: press.data } : {}),
    ...(message
      ? {
          message: {
            message_id: message.message_id,
            chat: { id: message.chat.id, type: message.chat.type },
            ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
            ...(message.is_topic_message ? { is_topic_message: true } : {}),
          },
        }
      : {}),
  };
  return {
    id: String(update.update_id),
    source: `telegram:${botId}`,
    type: TELEGRAM_PRESS_EVENT,
    time: new Date().toISOString(),
    // The topic's subject: a press waits for the messages sent before it there.
    subject: message ? telegramThreadId(message) : null,
    sequence: update.update_id,
    projectId,
    // Only what the press handler reads: no names, no question text.
    data: { callback_query: stored as unknown as Record<string, unknown> },
  };
}

/**
 * One message for the agent and the session view: the core renders it
 * (`channelPromptText`). A button press keeps no names (`telegramPressEvent`),
 * so its sender is the username or the id.
 */
export function telegramEnvelope(message: TelegramMessage): ChannelEnvelope {
  const { chat, from } = message;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ');
  const topic = message.is_topic_message ? message.message_thread_id : undefined;
  return {
    platform: CHANNELS.telegram.envelope,
    sender: from?.username ? `@${from.username}` : name || `user ${from?.id ?? 'unknown'}`,
    where: chat.type === 'private' ? 'direct message' : chat.title || `chat ${chat.id}`,
    text: telegramText(message),
    reply: connectorReply(TELEGRAM_CHANNEL_CONNECTOR_SLUG, 'send_message', {
      chat_id: String(chat.id),
      text: '<reply>',
      reply_parameters: { message_id: message.message_id },
      ...(topic ? { message_thread_id: topic } : {}),
    }),
    notes: [
      `Chat ${chat.id} (${chat.type})${topic ? `, topic ${topic}` : ''}, sender id ${from?.id ?? 'unknown'}, message id ${message.message_id}.`,
      ...(message.media_group_id
        ? ['This message is one item of an album. Telegram sends each item as its own message, and usually only the first carries the caption.']
        : []),
      `One message holds at most ${CHANNELS.telegram.messageChars} characters; send a longer answer as several messages.`,
      'Whenever you need the user to choose or to answer, call your question tool, with every question in one call: Kortix shows them in this chat as buttons, one question at a time.',
      'Never list choices or questions as plain text. Ask in plain words only when the tool result says the question could not be posted.',
      `While you work on a long task, show typing: ${connectorReply(TELEGRAM_CHANNEL_CONNECTOR_SLUG, 'send_chat_action', { chat_id: String(chat.id) })}.`,
      'For bold or code, add `"parse_mode":"HTML"` and use <b>, <i>, <code>, <pre>; otherwise send plain text.',
      'The bot token is resolved server-side. Do not look for it in the sandbox.',
      `The next message in this chat continues this session. Kortix answers ${kortixCommandsSentence()} in the chat itself; those commands never reach you.`,
    ],
  };
}
