import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { buildReadRange, readFile } from "./read";
import { formatTitlePath } from "./render";
import { type ReadInput, readSchema } from "./schema";

const PREVIEW_LINES = 10;

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "read",
    label: "read",
    description:
      "Read a local UTF-8 text file. Output is `LINE:CONTENT` with no space after the colon. Capped at 32KB per call; lines longer than 2000 chars are truncated.",
    promptSnippet: "Read text files.",
    parameters: readSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, start, end } = params as ReadInput;

      if (signal?.aborted) {
        throw new Error("Read aborted before execution.");
      }

      const range = buildReadRange(start, end);
      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await readFile(absolutePath, range);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: outcome.body },
      ];

      if (outcome.truncatedByEnd && outcome.nextStart !== undefined) {
        content.push({
          type: "text",
          text: `[read tool: showing lines ${outcome.visibleStart}-${outcome.visibleEnd} of ${outcome.totalLines}; call read again with start=${outcome.nextStart} to continue.]`,
        });
      }

      return {
        content,
        details: {
          absolutePath,
          totalLines: outcome.totalLines,
          visibleStart: outcome.visibleStart,
          visibleEnd: outcome.visibleEnd,
          truncatedByByteCap: outcome.truncatedByByteCap,
          truncatedByEnd: outcome.truncatedByEnd,
          hadBom: outcome.hadBom,
          ...(outcome.nextStart === undefined
            ? {}
            : { nextStart: outcome.nextStart }),
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
