import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import { Tools } from "../../shared/Tools";
import { findFiles } from "./glob";
import { globView, renderFiles } from "./render";
import {
  GLOB_HEAD_LIMIT_MAX,
  type GlobInput,
  type GlobPathFormat,
  globSchema,
} from "./schema";

const DEFAULT_PATH_FORMAT: GlobPathFormat = "relative";

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "glob",
    label: "glob",
    description:
      "Find files by glob pattern under a directory, sorted newest first. " +
      "Skips gitignored paths and dotfiles unless requested. " +
      "Use glob to enumerate files instead of bash with find, fd, ls -R, or similar.",
    parameters: globSchema,
    renderShell: "self",
    effect: { kind: "readOnly" },
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const {
        pattern,
        path,
        exclude,
        includeDotfiles,
        includeIgnored,
        pathFormat,
        headLimit,
      } = params as GlobInput;

      if (signal?.aborted) {
        throw new Error("Glob aborted before execution.");
      }

      const scan = {
        exclude,
        includeDotfiles: includeDotfiles ?? false,
        includeIgnored: includeIgnored ?? false,
      };
      const resolvedPathFormat = pathFormat ?? DEFAULT_PATH_FORMAT;
      const absolutePath = Paths.resolve(path ?? ".", ctx.cwd);
      const matches = await findFiles(absolutePath, pattern, scan);
      const outcome = renderFiles(matches, headLimit ?? GLOB_HEAD_LIMIT_MAX, {
        cwd: ctx.cwd,
        pathFormat: resolvedPathFormat,
      });
      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncated) {
        content.push({
          type: "text",
          text: `[glob tool: showing ${outcome.visibleItems} of ${outcome.totalItems} entries; narrow the pattern or scope to a specific path to reduce results.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          pattern,
          ...scan,
          pathFormat: resolvedPathFormat,
          fileCount: matches.length,
          totalItems: outcome.totalItems,
          visibleItems: outcome.visibleItems,
          truncated: outcome.truncated,
        },
      };
    },
    toViewModel: globView,
  });
}
