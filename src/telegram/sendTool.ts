import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { GrammyError, InputFile, type Api } from "grammy";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { type Static, Type } from "typebox";

import { Paths } from "../shared/Paths.ts";
import { toHtml } from "./markdown.ts";
import type { ThreadHandle } from "./SessionRegistry.ts";

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_CAPTION_CHARS = 1024;

const sendFileSchema = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
  caption: Type.Optional(
    Type.String({
      description: `File caption in markdown. Max ${MAX_CAPTION_CHARS} chars.`,
      maxLength: MAX_CAPTION_CHARS,
    })
  ),
});

type SendFileInput = Static<typeof sendFileSchema>;

export type SendFileDeps = {
  readonly api: Api;
  readonly handle: ThreadHandle;
  readonly cwd: string;
};

export function buildSendFileTool(deps: SendFileDeps): ToolDefinition {
  return defineTool({
    name: "send_file",
    label: "send_file",
    description: `Send a local file to the current Telegram chat/thread as a document. Max ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`,
    parameters: sendFileSchema,
    async execute(_id, params) {
      const { path: rawPath, caption } = params as SendFileInput;
      const resolved = await validate(rawPath, deps.cwd);
      const trimmedCaption = caption?.slice(0, MAX_CAPTION_CHARS);
      await send(deps.api, deps.handle, resolved.path, trimmedCaption);
      return {
        content: [{ type: "text", text: `Sent ${basename(resolved.path)}` }],
        details: {
          path: resolved.path,
          bytes: resolved.size,
        },
      };
    },
  });
}

async function validate(
  rawPath: string,
  cwd: string
): Promise<{ readonly path: string; readonly size: number }> {
  const path = Paths.resolve(rawPath, cwd);
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    throw new Error(`${rawPath}: ${(err as Error).message}`);
  }
  if (!st.isFile()) {
    throw new Error(`${rawPath} is not a regular file.`);
  }
  if (st.size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `${rawPath} is ${st.size} bytes; max allowed is ${MAX_DOCUMENT_BYTES}.`
    );
  }
  return { path, size: st.size };
}

async function send(
  api: Api,
  handle: ThreadHandle,
  path: string,
  caption: string | undefined
): Promise<void> {
  const html = caption ? toHtml(caption) : undefined;
  try {
    await api.sendDocument(handle.chatId, new InputFile(path), {
      message_thread_id: handle.threadId,
      caption: html,
      parse_mode: html ? "HTML" : undefined,
    });
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400 && html) {
      await api.sendDocument(handle.chatId, new InputFile(path), {
        message_thread_id: handle.threadId,
        caption,
      });
      return;
    }
    throw err;
  }
}
