import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import type { Context, Filter } from "grammy";
import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { ThreadHandle } from "../SessionRegistry";

type AttachmentFile = {
  readonly path: string;
  readonly mimeType: string;
  readonly imageBase64: string | undefined;
};

export type AttachmentPrompt = {
  readonly text: string;
  readonly options: Pick<PromptOptions, "images">;
};

const IMAGE_BYTES_LIMIT = 4 * 1024 * 1024;

export async function buildPromptWithAttachments(
  ctx: Filter<Context, "message">,
  token: string,
  configDir: string,
  handle: ThreadHandle
): Promise<AttachmentPrompt | undefined> {
  const message = ctx.message;
  const text = ("text" in message ? message.text : undefined) ?? "";
  const caption = ("caption" in message ? message.caption : undefined) ?? "";
  const files = await downloadMessageFiles(ctx, token, configDir, handle);

  const attachments: string[] = [];
  const images: NonNullable<PromptOptions["images"]> = [];
  for (const file of files) {
    if (file.imageBase64) {
      images.push({
        type: "image",
        data: file.imageBase64,
        mimeType: file.mimeType,
      });
      attachments.push(`[Image attachment: ${file.path}]`);
      continue;
    }
    attachments.push(`[Attachment: ${file.path}]`);
  }

  const body = (text || caption || "").trim();
  const prompt = [body, ...attachments].filter(Boolean).join("\n\n").trim();
  if (!prompt && images.length === 0) {
    return undefined;
  }
  return {
    text: prompt || "Please analyze the attached image.",
    options: images.length > 0 ? { images } : {},
  };
}

async function downloadMessageFiles(
  ctx: Filter<Context, "message">,
  token: string,
  configDir: string,
  handle: ThreadHandle
): Promise<ReadonlyArray<AttachmentFile>> {
  const refs = fileRefs(ctx);
  if (refs.length === 0) {
    return [];
  }

  const dir = join(configDir, "attachments", String(handle.chatId));
  await mkdir(dir, { recursive: true });
  const out: AttachmentFile[] = [];
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
    const ext =
      extname(telegramFile.file_path) || extname(ref.name ?? "") || ref.ext;
    const filename = safeName(
      `${ref.uniqueId ?? ref.fileId}-${Date.now()}${ext}`
    );
    const path = join(dir, filename);
    const bytes = await response.arrayBuffer();
    await Bun.write(path, bytes);
    const isImage = ref.mimeType.startsWith("image/");
    out.push({
      path,
      mimeType: ref.mimeType,
      imageBase64:
        isImage && bytes.byteLength <= IMAGE_BYTES_LIMIT
          ? Buffer.from(bytes).toString("base64")
          : undefined,
    });
  }
  return out;
}

function fileRefs(ctx: Filter<Context, "message">): ReadonlyArray<{
  readonly fileId: string;
  readonly uniqueId?: string;
  readonly name?: string;
  readonly mimeType: string;
  readonly ext: string;
}> {
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
  if ("document" in message && message.document) {
    const doc = message.document;
    return [
      {
        fileId: doc.file_id,
        uniqueId: doc.file_unique_id,
        name: doc.file_name,
        mimeType: doc.mime_type ?? "application/octet-stream",
        ext: extname(doc.file_name ?? "") || ".bin",
      },
    ];
  }
  if ("video" in message && message.video) {
    const video = message.video;
    return [
      {
        fileId: video.file_id,
        uniqueId: video.file_unique_id,
        name: video.file_name,
        mimeType: video.mime_type ?? "video/mp4",
        ext: extname(video.file_name ?? "") || ".mp4",
      },
    ];
  }
  if ("audio" in message && message.audio) {
    const audio = message.audio;
    return [
      {
        fileId: audio.file_id,
        uniqueId: audio.file_unique_id,
        name: audio.file_name,
        mimeType: audio.mime_type ?? "audio/mpeg",
        ext: extname(audio.file_name ?? "") || ".mp3",
      },
    ];
  }
  if ("voice" in message && message.voice) {
    const voice = message.voice;
    return [
      {
        fileId: voice.file_id,
        uniqueId: voice.file_unique_id,
        mimeType: voice.mime_type ?? "audio/ogg",
        ext: ".ogg",
      },
    ];
  }
  return [];
}

function safeName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}
