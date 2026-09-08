import { defineTool } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { type Static, Type } from "typebox";

import type { AttachmentStore } from "#core/attachments/AttachmentStore";
import { Paths } from "#core/shared/Paths";
import { SendFile } from "#core/shared/SendFile";
import type { PimToolDefinition } from "#core/shared/Tools";
import type { ToolView } from "#core/view/ViewBlock";
import { attachmentUrl } from "./AttachmentEndpoint";

const sendFileSchema = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
});

type SendFileInput = Static<typeof sendFileSchema>;

type SendFileDetails = {
  readonly name: string;
  readonly url: string;
  readonly isImage: boolean;
};

export type SendFileDeps = {
  readonly store: AttachmentStore;
  readonly cwd: string;
  /** Pi's session uuid, read at call time. */
  readonly sessionId: () => string | undefined;
};

function build(
  deps: SendFileDeps
): PimToolDefinition<typeof sendFileSchema, SendFileDetails> {
  return {
    ...defineTool({
      name: "send_file",
      label: "send_file",
      description: `Send a local file to the user's web browser. Images appear inline. Max ${SendFile.MAX_BYTES / (1024 * 1024)} MB.`,
      parameters: sendFileSchema,
      async execute(_id, params) {
        const { path: rawPath } = params as SendFileInput;
        const { path, size } = await SendFile.validate(rawPath, deps.cwd);
        const scope = deps.sessionId();
        if (!scope) {
          throw new Error("This session cannot send files yet.");
        }
        const stored = await deps.store.storeFile(scope, path);
        const details: SendFileDetails = {
          name: basename(path),
          url: attachmentUrl(stored.path),
          isImage: stored.mimeType.startsWith("image/"),
        };
        return {
          // Never the URL: an address the model can repeat is a second, dead copy of this delivery.
          content: [{ type: "text", text: `Sent ${details.name} (${size} B)` }],
          details,
        };
      },
    }),
    effect: { kind: "readOnly" },
    toViewModel: ({ args, result, cwd }): ToolView => {
      const details = result?.details;
      return {
        label: "Send File",
        icon: "upload",
        title: [
          {
            kind: "file",
            path: Paths.titleOr(
              (args as Partial<SendFileInput> | undefined)?.path,
              cwd
            ),
          },
        ],
        ...(details === undefined
          ? {}
          : {
              summary: [{ kind: "attachment", ...details }],
            }),
      };
    },
  };
}

export const SendFileTool = { build };
