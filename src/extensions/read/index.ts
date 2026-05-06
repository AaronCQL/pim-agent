import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Renderer } from "../../shared/Renderer";
import { buildReadRange, readFile, resolveReadPath } from "./read";
import { formatTitlePath } from "./render";
import { type ReadInput, readSchema } from "./schema";

const PREVIEW_LINES = 10;

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read a UTF-8 text file. Hashline output uses `LINE+ID|content` anchors such as `41th|def alpha():`; copy anchors verbatim into edit. Filesystem files only: use web_fetch for URLs and glob for directory listings.",
    promptSnippet: "Read text files (hashline anchors for edit).",
    parameters: readSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, start, end, format } = params as ReadInput;

      if (signal?.aborted) {
        throw new Error("Read aborted before execution.");
      }

      const range = buildReadRange(start, end, format);
      const absolutePath = resolveReadPath(path, ctx.cwd);
      const outcome = await readFile(absolutePath, range);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (
        outcome.truncatedByByteCap &&
        outcome.nextStart !== undefined &&
        outcome.firstLineTooBig === undefined
      ) {
        content.push({
          type: "text",
          text: `[read tool: showing lines ${outcome.visibleStart}-${outcome.visibleEnd} of ${outcome.totalLines}; call read again with start=${outcome.nextStart} to continue.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          format: range.format,
          totalLines: outcome.totalLines,
          visibleStart: outcome.visibleStart,
          visibleEnd: outcome.visibleEnd,
          truncatedByByteCap: outcome.truncatedByByteCap,
          ...(outcome.nextStart === undefined
            ? {}
            : { nextStart: outcome.nextStart }),
          ...(outcome.firstLineTooBig === undefined
            ? {}
            : { firstLineTooBig: outcome.firstLineTooBig }),
        },
      };
    },
    renderCall(args, theme, context) {
      const input = (args ?? {}) as Partial<ReadInput>;
      const title = formatTitlePath({
        path: input.path,
        cwd: context.cwd,
        start: input.start,
        end: input.end,
        format: input.format ?? "hashline",
      });
      return Renderer.renderToolCallTitle({
        label: "Read",
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
