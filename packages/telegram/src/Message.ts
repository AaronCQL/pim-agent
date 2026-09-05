import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import type { Context, Filter } from "grammy";
import { extname, join } from "node:path";

import {
  AttachmentStore,
  type StoredAttachment,
  toAttachmentPrompt,
} from "#core/attachments/AttachmentStore";
import type { SessionId } from "./Session";

type FileRef = {
  readonly fileId: string;
  readonly uniqueId?: string;
  readonly name?: string;
  readonly mimeType: string;
  readonly ext: string;
};

export type Prompt = {
  readonly text: string;
  readonly options: Pick<PromptOptions, "images">;
};

const REPLY_QUOTE_HEAD = 128;
const REPLY_QUOTE_TAIL = 128;

async function toPrompt(
  ctx: Filter<Context, "message">,
  token: string,
  configDir: string,
  sessionId: SessionId
): Promise<Prompt | undefined> {
  const message = ctx.message;
  const text = ("text" in message ? message.text : undefined) ?? "";
  const caption = ("caption" in message ? message.caption : undefined) ?? "";
  const files = await download(ctx, token, configDir, sessionId);
  const { lines: attachments, images } = toAttachmentPrompt(files);

  const body = (text || caption || "").trim();
  if (!body && images.length === 0 && attachments.length === 0) {
    return undefined;
  }
  const replyContext = buildReplyContext(ctx);
  const promptText = [replyContext, body, ...attachments]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return {
    text: promptText,
    options: images.length > 0 ? { images } : {},
  };
}

function buildReplyContext(
  ctx: Filter<Context, "message">
): string | undefined {
  const reply = ctx.message.reply_to_message;
  if (!reply) {
    return undefined;
  }
  const raw = ctx.message.quote?.text ?? reply.text ?? reply.caption ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const truncated =
    trimmed.length > REPLY_QUOTE_HEAD + REPLY_QUOTE_TAIL + 1
      ? `${trimmed.slice(0, REPLY_QUOTE_HEAD)}…${trimmed.slice(-REPLY_QUOTE_TAIL)}`
      : trimmed;
  const quoted = truncated
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const isFromBot = reply.from?.id === ctx.me.id;
  const label = isFromBot
    ? "Replying to your earlier message:"
    : "Replying to my earlier message:";
  return `${label}\n${quoted}`;
}

/** Telegram's half of the shared upload flow: fetch bytes, then store them. */
async function download(
  ctx: Filter<Context, "message">,
  token: string,
  configDir: string,
  sessionId: SessionId
): Promise<ReadonlyArray<StoredAttachment>> {
  const refs = refsOf(ctx);
  if (refs.length === 0) {
    return [];
  }

  const store = new AttachmentStore(join(configDir, "attachments"));
  const out: StoredAttachment[] = [];
  for (const ref of refs) {
    const telegramFile = await ctx.api.getFile(ref.fileId);
    if (!telegramFile.file_path) {
      continue;
    }
    const url = `https://api.telegram.org/file/bot${token}/${telegramFile.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }
    out.push(
      await store.store(String(sessionId.chatId), {
        bytes: await response.arrayBuffer(),
        mimeType: ref.mimeType,
        stem: ref.uniqueId ?? ref.fileId,
        ext:
          extname(telegramFile.file_path) || extname(ref.name ?? "") || ref.ext,
      })
    );
  }
  return out;
}

const MEDIA_KINDS = [
  {
    key: "document",
    defaultMime: "application/octet-stream",
    defaultExt: ".bin",
  },
  { key: "video", defaultMime: "video/mp4", defaultExt: ".mp4" },
  { key: "audio", defaultMime: "audio/mpeg", defaultExt: ".mp3" },
  { key: "voice", defaultMime: "audio/ogg", defaultExt: ".ogg" },
] as const;

function refsOf(ctx: Filter<Context, "message">): ReadonlyArray<FileRef> {
  const message = ctx.message;
  if ("photo" in message && message.photo) {
    const photo = message.photo.at(-1)!;
    return [
      {
        fileId: photo.file_id,
        uniqueId: photo.file_unique_id,
        mimeType: "image/jpeg",
        ext: ".jpg",
      },
    ];
  }
  for (const { key, defaultMime, defaultExt } of MEDIA_KINDS) {
    const file = key in message ? message[key] : undefined;
    if (!file) {
      continue;
    }
    const name = "file_name" in file ? file.file_name : undefined;
    return [
      {
        fileId: file.file_id,
        uniqueId: file.file_unique_id,
        name,
        mimeType: file.mime_type ?? defaultMime,
        ext: extname(name ?? "") || defaultExt,
      },
    ];
  }
  return [];
}

export const Message = { toPrompt };
