import { GrammyError, type Api } from "grammy";

import type { SessionId } from "./Session";
import { TelegramHtml } from "./TelegramHtml";

export type SentMessage = { readonly message_id: number };

/** Falls back to plain text when Telegram rejects the markup. */
async function send(
  api: Api,
  chat: SessionId,
  html: string,
  kind: string
): Promise<SentMessage | undefined> {
  if (!html) {
    return undefined;
  }
  const clean = TelegramHtml.sanitize(html);
  try {
    const msg = await api.sendRichMessage(
      chat.chatId,
      { html: clean },
      { message_thread_id: chat.threadId }
    );
    console.log(
      `[send] chatId=${chat.chatId} threadId=${chat.threadId ?? "main"} ${kind} ok (${clean.length}b)`
    );
    return msg;
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400) {
      console.warn(`[send] rich 400 (${err.description}) — retry plain`);
      return api.sendMessage(chat.chatId, TelegramHtml.strip(clean), {
        message_thread_id: chat.threadId,
        link_preview_options: { is_disabled: true },
      });
    }
    throw err;
  }
}

export type EditOutcome = "edited" | "missing" | "failed";

/** Never throws: an unchanged body counts as edited and rejected markup is retried as plain text. */
async function edit(
  api: Api,
  chat: SessionId,
  messageId: number,
  html: string,
  kind: string
): Promise<EditOutcome> {
  const clean = TelegramHtml.sanitize(html);
  try {
    await api.editMessageText(chat.chatId, messageId, { html: clean });
    return "edited";
  } catch (err) {
    if (err instanceof GrammyError) {
      if (/message is not modified/i.test(err.description)) {
        return "edited";
      }
      if (/message to edit not found/i.test(err.description)) {
        return "missing";
      }
      if (err.error_code === 400) {
        return api
          .editMessageText(chat.chatId, messageId, TelegramHtml.strip(clean), {
            link_preview_options: { is_disabled: true },
          })
          .then(
            () => "edited",
            () => "failed"
          );
      }
    }
    console.warn(`[send] ${kind} edit failed:`, err);
    return "failed";
  }
}

export const RichMessage = { send, edit };
