/**
 * What a person reads: a command reply (core/commands.ts `CommandReply`) and
 * an agent question (core/questions.ts `QuestionMessage`) as plain chat text
 * and an inline keyboard. Pure: no network, no database.
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { type CommandPress, pressData } from '../core/command-press';
import type { CommandReply } from '../core/commands';
import type { ChannelTarget } from '../core/conversation';
import { type QuestionFooter, type QuestionMessage, type QuestionTapReply } from '../core/questions';

/** Option buttons on one page (Teams parity, teams/cards.ts); more options turn pages. */
export const MAX_BUTTONS = CHANNELS.telegram.buttons.max;
/** 3900: of the 4096 characters a message holds, the footer gets 190, the blank line 2, and 4 stay spare. */
const QUESTION_BODY_MAX = CHANNELS.telegram.messageChars - 196;
/** A tap on a question nothing can answer any more: its session is gone, or the chat moved on. */
const EARLIER_QUESTION = 'This question is from an earlier conversation. Send your answer as a message.';

/** At most `max` UTF-16 units, never half an emoji: Telegram refuses a lone surrogate. */
export function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Questions as chat text: each question with its numbered options, then the
 * footer. `step`: one question of several, under "Question <at> of <count>".
 */
export function telegramQuestionText(questions: RuntimeQuestion[], footer: string, step?: QuestionMessage['step']): string {
  const title = (q: RuntimeQuestion, i: number) =>
    step
      ? `Question ${step.at} of ${step.count}${q.header ? ` · ${q.header}` : ''}\n${q.question}`
      : `${questions.length > 1 ? `${i + 1}) ` : ''}${q.header ? `${q.header}: ` : ''}${q.question}`;
  const body = questions
    .map((q, i) =>
      [
        `${title(q, i)}${q.multiple ? ' (pick one or more)' : ''}`,
        ...q.options.map((o, j) => `${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
  return `${clip(body, QUESTION_BODY_MAX)}\n\n${clip(footer, 190)}`;
}

/** A question message's last line; a tap's toast uses the same words. */
export function questionFooter(footer: QuestionFooter | QuestionTapReply): string {
  switch (footer.kind) {
    case 'ask':
      return footer.buttons
        ? 'Tap an option, or reply to this message with your own answer.'
        : `Reply to this message with your answer${footer.numbered ? ', each question by its number' : ''}.`;
    case 'step':
      return `${footer.many ? 'Tap each option you want, then Done' : 'Tap an option'}${footer.typed ? ', or type your own answer' : ''}.`;
    case 'already_answered':
      return 'This question was already answered.';
    case 'none_ticked':
      return 'Tap at least one option first.';
    case 'answered':
      return `Answered: ${footer.label}`;
    case 'answered_in_chat':
      return 'Answered in the chat.';
    case 'new_conversation':
      return 'A new conversation started.';
    case 'earlier':
      return EARLIER_QUESTION;
  }
}

export const questionMessageText = (m: QuestionMessage) =>
  m.questions.length ? telegramQuestionText(m.questions, questionFooter(m.footer), m.step) : questionFooter(m.footer);

/** One option a row, ✓ on a ticked one; then the page turns; then Done. */
export function inlineKeyboard(m: QuestionMessage): InlineButton[][] {
  const button = (text: string, data: string): InlineButton => ({ text: clip(text, 60), callback_data: data });
  const turn = [...(m.back ? [button('‹ Back', m.back)] : []), ...(m.more ? [button('More ›', m.more)] : [])];
  return [
    ...(m.buttons ?? []).map((b) => [button(`${b.ticked ? '✓ ' : ''}${b.label}`, b.data)]),
    ...(turn.length ? [turn] : []),
    ...(m.done ? [[button('Done ›', m.done)]] : []),
  ];
}

/** The question as the agent would send it with `send_message`. */
export function questionBody(target: ChannelTarget, m: QuestionMessage): Record<string, unknown> {
  const [chatId, topicId] = target.threadId.split(':');
  return {
    // A string, as the agent sends it, so a policy condition on it decides as it would for the agent.
    chat_id: chatId,
    text: questionMessageText(m),
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    ...(m.buttons ? { reply_markup: { inline_keyboard: inlineKeyboard(m) } } : {}),
  };
}

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

/**
 * A command's reply (core/commands.ts `CommandReply`) as plain chat text and an inline keyboard:
 * one row per option, then the page row, then the actions in pairs, then a panel's https link.
 * Any other link is the last text line: Telegram may refuse a URL button for a host such as localhost.
 */
export function telegramCommandMessage(reply: CommandReply): { text: string; keyboard: InlineButton[][] } {
  const button = (label: string, press: CommandPress): InlineButton => ({ text: clip(label, 60), callback_data: pressData(press) });
  const lines: string[] = [];
  const keyboard: InlineButton[][] = [];
  switch (reply.kind) {
    case 'notice':
      lines.push(reply.text);
      break;
    case 'panel':
      lines.push(reply.title, ...reply.rows.map((r) => `${r.label}: ${r.value}`));
      break;
    case 'choices': {
      lines.push(`${reply.title}${reply.pages > 1 ? ` (page ${reply.page + 1} of ${reply.pages})` : ''}`, reply.usage);
      keyboard.push(...reply.options.map((o) => [button(`${o.current ? '✓ ' : ''}${o.label}`, o.press)]));
      const turn = [...(reply.back ? [button('‹ Back', reply.back)] : []), ...(reply.more ? [button('More ›', reply.more)] : [])];
      if (turn.length) keyboard.push(turn);
      break;
    }
    case 'help':
      lines.push(reply.intro, ...reply.commands.map((c) => `${c.usage} — ${c.description}`), reply.footer);
      break;
  }
  const actions = (reply.actions ?? []).map((a) => button(a.label, a.press));
  for (let i = 0; i < actions.length; i += 2) keyboard.push(actions.slice(i, i + 2));
  const url = 'url' in reply ? reply.url : undefined;
  if (url && reply.kind === 'panel' && url.startsWith('https://')) keyboard.push([{ text: 'Open in Kortix', url }]);
  else if (url) lines.push(url);
  return { text: reply.note ? `${lines.join('\n')}\n\n${reply.note}` : lines.join('\n'), keyboard };
}
