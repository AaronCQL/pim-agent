import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { findFiles } from "./glob";
import { formatTitle, renderFiles } from "./render";
import { GLOB_HEAD_LIMIT_MAX, type GlobInput, globSchema } from "./schema";

const PREVIEW_LINES = 10;
const fileCountByToolCallId = new Map<string, number>();

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "glob",
    label: "glob",
    description:
      "Find files by glob pattern under a directory, sorted newest first. Skips gitignored paths and dotfiles. Use glob to enumerate files instead of bash with find, fd, ls -R, or similar.",
    parameters: globSchema,
    renderShell: "self",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const { pattern, path, headLimit } = params as GlobInput;

      if (signal?.aborted) {
        throw new Error("Glob aborted before execution.");
      }

      const limit = headLimit ?? GLOB_HEAD_LIMIT_MAX;
      const absolutePath = Paths.resolve(path ?? ".", ctx.cwd);
      const matches = await findFiles(absolutePath, pattern);
      const outcome = renderFiles(matches, limit);
      fileCountByToolCallId.set(toolCallId, matches.length);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncated) {
        content.push({
          type: "text",
          text: `[glob tool: showing ${outcome.visibleItems} of ${outcome.totalItems} entries; raise headLimit (max ${GLOB_HEAD_LIMIT_MAX}) or narrow the pattern to see more.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          pattern,
          totalItems: outcome.totalItems,
          visibleItems: outcome.visibleItems,
          truncated: outcome.truncated,
        },
      };
    },
    renderCall(args, theme, context) {
      const input = (args ?? {}) as Partial<GlobInput>;
      const title = formatTitle({
        pattern: input.pattern,
        path: input.path,
        cwd: context.cwd,
        fileCount: fileCountByToolCallId.get(context.toolCallId),
      });
      return Renderer.renderToolCallTitle({
        label: "Glob",
        title,
        theme,
        context,
      });
    },
    renderResult(result, options, theme, context) {
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
