import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { buildRegex, findMatches } from "./grep";
import { formatTitle, renderMatches } from "./render";
import {
  GREP_HEAD_LIMIT_MAX,
  type GrepInput,
  type GrepOutputMode,
  grepSchema,
} from "./schema";

const PREVIEW_LINES = 10;
const DEFAULT_OUTPUT_MODE: GrepOutputMode = "files_with_matches";
const fileCountByToolCallId = new Map<string, number>();

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "grep",
    label: "grep",
    description:
      "Search UTF-8 text files for a JavaScript regex. Skips binary files, gitignored paths, and dotfiles. Use grep to search file contents instead of bash with grep, rg, ag, find -exec, or similar.",
    parameters: grepSchema,
    renderShell: "self",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const {
        pattern,
        path,
        glob,
        outputMode,
        multiline,
        caseInsensitive,
        headLimit,
      } = params as GrepInput;

      if (signal?.aborted) {
        throw new Error("Grep aborted before execution.");
      }

      const mode = outputMode ?? DEFAULT_OUTPUT_MODE;
      const limit = Math.min(
        headLimit ?? GREP_HEAD_LIMIT_MAX,
        GREP_HEAD_LIMIT_MAX
      );
      const regex = buildRegex(
        pattern,
        multiline ?? false,
        caseInsensitive ?? false
      );
      const absolutePath = Paths.resolve(path ?? ".", ctx.cwd);
      const matches = await findMatches(absolutePath, glob, regex);
      const outcome = renderMatches(matches, mode, limit);
      fileCountByToolCallId.set(toolCallId, outcome.fileCount);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncated) {
        content.push({
          type: "text",
          text: `[grep tool: showing ${outcome.visibleItems} of ${outcome.totalItems} ${outcome.itemNoun}; raise headLimit (max ${GREP_HEAD_LIMIT_MAX}) or narrow the pattern/glob to see more.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          outputMode: mode,
          fileCount: outcome.fileCount,
          totalMatches: outcome.totalMatches,
          totalItems: outcome.totalItems,
          visibleItems: outcome.visibleItems,
          truncated: outcome.truncated,
        },
      };
    },
    renderCall(args, theme, context) {
      const input = (args ?? {}) as Partial<GrepInput>;
      const title = formatTitle({
        pattern: input.pattern,
        path: input.path,
        glob: input.glob,
        cwd: context.cwd,
        fileCount: fileCountByToolCallId.get(context.toolCallId),
      });
      return Renderer.renderToolCallTitle({
        label: "Grep",
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
