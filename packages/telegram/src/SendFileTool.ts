import { defineTool } from "@earendil-works/pi-coding-agent";
import { InputFile, type Api } from "grammy";
import { basename } from "node:path";

import { SendFile } from "#core/shared/SendFile";
import type { PimToolDefinition } from "#core/shared/Tools";
import type { ToolView } from "#core/view/ViewBlock";
import {
  MAX_CAPTION_CHARS,
  sendFileSchema,
  type SendFileInput,
} from "./SendFileSchema";
import type { SessionId } from "./Session";

export type SendFileDeps = {
  readonly api: Api;
  readonly sessionId: SessionId;
  readonly cwd: string;
};

function build(deps: SendFileDeps): PimToolDefinition<typeof sendFileSchema> {
  return {
    ...defineTool({
      name: "send_file",
      label: "send_file",
      description: `Send a local file to the current Telegram chat/thread as a document. Max ${SendFile.MAX_BYTES / (1024 * 1024)} MB.`,
      parameters: sendFileSchema,
      async execute(_id, params) {
        const { path: rawPath, caption } = params as SendFileInput;
        const resolved = await SendFile.validate(rawPath, deps.cwd);
        const trimmedCaption = caption?.slice(0, MAX_CAPTION_CHARS);
        await send(deps.api, deps.sessionId, resolved.path, trimmedCaption);
        return {
          content: [{ type: "text", text: `Sent ${basename(resolved.path)}` }],
          details: {
            path: resolved.path,
            bytes: resolved.size,
          },
        };
      },
    }),
    toViewModel: ({ args }): ToolView => {
      const path = (args as Partial<SendFileInput> | undefined)?.path;
      return {
        label: "Send File",
        icon: "upload",
        title: [{ kind: "file", path: path ?? "..." }],
      };
    },
  };
}

async function send(
  api: Api,
  sessionId: SessionId,
  path: string,
  caption: string | undefined
): Promise<void> {
  await api.sendDocument(sessionId.chatId, new InputFile(path), {
    message_thread_id: sessionId.threadId,
    caption,
  });
}

export const SendFileTool = { build };
