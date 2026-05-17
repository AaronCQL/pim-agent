import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { GrammyError, InputFile, type Api } from "grammy";
import { basename } from "node:path";

import { FsErrors } from "../shared/FsErrors";
import { Paths } from "../shared/Paths";
import { Markdown } from "./Markdown";
import {
  MAX_CAPTION_CHARS,
  MAX_DOCUMENT_BYTES,
  sendFileSchema,
  type SendFileInput,
} from "./SendFileSchema";
import type { SessionId } from "./Session";

export type SendFileDeps = {
  readonly api: Api;
  readonly sessionId: SessionId;
  readonly cwd: string;
};

export class SendFileTool {
  public static build(deps: SendFileDeps): ToolDefinition {
    return defineTool({
      name: "send_file",
      label: "send_file",
      description: `Send a local file to the current Telegram chat/thread as a document. Max ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`,
      parameters: sendFileSchema,
      async execute(_id, params) {
        const { path: rawPath, caption } = params as SendFileInput;
        const resolved = await SendFileTool.validate(rawPath, deps.cwd);
        const trimmedCaption = caption?.slice(0, MAX_CAPTION_CHARS);
        await SendFileTool.send(
          deps.api,
          deps.sessionId,
          resolved.path,
          trimmedCaption
        );
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

  private static async validate(
    rawPath: string,
    cwd: string
  ): Promise<{ readonly path: string; readonly size: number }> {
    const path = Paths.resolve(rawPath, cwd);
    const st = await FsErrors.statOrThrow(path);
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

  private static async send(
    api: Api,
    sessionId: SessionId,
    path: string,
    caption: string | undefined
  ): Promise<void> {
    const html = caption ? Markdown.toHtml(caption) : undefined;
    try {
      await api.sendDocument(sessionId.chatId, new InputFile(path), {
        message_thread_id: sessionId.threadId,
        caption: html,
        parse_mode: html ? "HTML" : undefined,
      });
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400 && html) {
        await api.sendDocument(sessionId.chatId, new InputFile(path), {
          message_thread_id: sessionId.threadId,
          caption,
        });
        return;
      }
      throw err;
    }
  }
}
