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

/**
 * What the view needs, persisted so a replay redraws it with no live state —
 * which is exactly an `attachment` block's payload, and is spread into one.
 */
type SendFileDetails = {
  readonly name: string;
  /** Server-relative; the client resolves it against its own gateway. */
  readonly url: string;
  readonly isImage: boolean;
};

export type SendFileDeps = {
  readonly store: AttachmentStore;
  readonly cwd: string;
  /** Pi's session uuid, read at call time; see `CustomToolContext`. */
  readonly sessionId: () => string | undefined;
};

/**
 * The web's answer to Telegram's `send_file`, and deliberately the same name:
 * a tool name is the agent's API, and which frontend is carrying the bytes is
 * an implementation detail of it.
 *
 * The file is *copied* into the attachment store rather than served where it
 * lies. The store's names are stamped and immutable and its endpoint is never
 * told a path, so a delivered file cannot change or disappear under the
 * transcript that references it — and a browser is never handed the ability to
 * name a path on the agent's disk.
 */
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
          // The name and the size, never the URL: an address the model can
          // repeat is a second copy of this delivery, unreadable as prose and
          // dead in any transcript this server is not serving.
          content: [{ type: "text", text: `Sent ${details.name} (${size} B)` }],
          details,
        };
      },
    }),
    // Reads the workspace and writes only into the store's own root, so the
    // session's file picker is not stale afterwards.
    effect: { kind: "readOnly" },
    toViewModel: ({ args, result, cwd }): ToolView => {
      const details = result?.details;
      return {
        label: "Send File",
        icon: "upload",
        // The same title every path-taking tool draws: relative to the cwd
        // when it is inside it, and a placeholder while the argument is
        // still streaming.
        title: [
          {
            kind: "file",
            path: Paths.titleOr(
              (args as Partial<SendFileInput> | undefined)?.path,
              cwd
            ),
          },
        ],
        // In `summary`, the part of a view that renders in every state:
        // collapsed, expanded and mid-flight. It is the point of the row,
        // not a payload to go looking for.
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
