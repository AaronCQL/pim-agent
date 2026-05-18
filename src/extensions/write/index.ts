import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { DiffView } from "../../shared/DiffView";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { type WriteInput, writeSchema } from "./schema";
import { writeContent, type WriteOutcome } from "./write";

const ERROR_PREVIEW_LINES = 12;

type WriteRenderState = {
  titleComponent?: Component;
  path?: string;
};

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "write",
    label: "write",
    description:
      "Create or overwrite UTF-8 text files. Use write only for new files or full rewrites - prefer edit for changes to existing files.",
    parameters: writeSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, content } = params as WriteInput;

      if (signal?.aborted) {
        throw new Error("Write aborted before execution.");
      }

      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await writeContent(absolutePath, content);

      return {
        content: [{ type: "text", text: formatSummary(path, outcome) }],
        details: outcome,
      };
    },
    renderCall(args, theme, context) {
      const state = context.state as WriteRenderState;
      const rawPath = typeof args?.path === "string" ? args.path : undefined;
      const display = Paths.titleOr(rawPath, context.cwd);
      state.path = display;
      const markerColor = Renderer.markerColorFor(
        Boolean(context.isPartial),
        Boolean(context.isError)
      );
      const text = DiffView.buildTitle({
        label: "Write",
        path: display,
        stats: { added: 0, removed: 0 },
        theme,
        markerColor,
        lastComponent: context.lastComponent,
      });
      state.titleComponent = text;
      return text;
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WriteRenderState;
      const fallback =
        (context.lastComponent as Container | undefined) ?? new Container();

      if (options.isPartial) {
        fallback.clear();
        return fallback;
      }

      if (context.isError) {
        return Renderer.renderBorderedResult({
          result,
          options,
          theme,
          context,
          previewLines: ERROR_PREVIEW_LINES,
        });
      }

      const details = result.details as
        | { readonly diff?: WriteOutcome["diff"] }
        | undefined;
      const diff = details?.diff;
      const stats = DiffView.countStats(diff);

      if (state.titleComponent && state.path !== undefined) {
        DiffView.buildTitle({
          label: "Write",
          path: state.path,
          stats,
          theme,
          markerColor: Renderer.markerColorFor(false, false),
          lastComponent: state.titleComponent,
        });
      }

      if (!diff) {
        fallback.clear();
        return fallback;
      }

      return DiffView.buildBlock({
        diff,
        theme,
        lastComponent: context.lastComponent,
      });
    },
  });
}

function formatSummary(path: string, outcome: WriteOutcome): string {
  const verb = outcome.created ? "Created" : "Wrote";
  const eofNote =
    outcome.trailingNewlineChange === undefined
      ? ""
      : ` Trailing newline ${outcome.trailingNewlineChange}.`;

  if (
    outcome.diff === undefined &&
    !outcome.created &&
    outcome.diffSkipped === undefined
  ) {
    return `Wrote ${outcome.bytesWritten} bytes to ${path} (no content changes).${eofNote}`;
  }

  if (outcome.diffSkipped !== undefined) {
    return `${verb} ${outcome.bytesWritten} bytes at ${path} (diff omitted: file exceeds ${outcome.diffSkipped.thresholdBytes}-byte render cap).${eofNote}`;
  }

  return `${verb} ${outcome.bytesWritten} bytes at ${path}.${eofNote}`;
}
