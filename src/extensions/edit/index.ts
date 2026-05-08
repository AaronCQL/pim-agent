import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, type Text } from "@mariozechner/pi-tui";
import { DiffView } from "../../shared/DiffView";
import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import { type EditOutcome, editFile, formatEditSummary } from "./edit";
import { type EditInput, editSchema } from "./schema";

const ERROR_PREVIEW_LINES = 12;

type EditRenderState = {
  titleComponent?: Text;
  path?: string;
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Replace strings in a UTF-8 text file. Prefer edit over write for changes to existing files.",
    parameters: editSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { path, edits } = params as EditInput;

      if (signal?.aborted) {
        throw new Error("Edit aborted before execution.");
      }

      const absolutePath = Paths.resolve(path, ctx.cwd);
      const outcome = await editFile(absolutePath, edits);

      return {
        content: [{ type: "text", text: formatEditSummary(path, outcome) }],
        details: outcome,
      };
    },
    renderCall(args, theme, context) {
      const state = context.state as EditRenderState;
      const rawPath = typeof args?.path === "string" ? args.path : undefined;
      const display = Paths.titleOr(rawPath, context.cwd);
      state.path = display;
      const markerColor = Renderer.markerColorFor(
        Boolean(context.isPartial),
        Boolean(context.isError)
      );
      const text = DiffView.buildTitle({
        label: "Edit",
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
      const state = context.state as EditRenderState;
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
        | { readonly diff?: EditOutcome["diff"] }
        | undefined;
      const diff = details?.diff;
      const stats = DiffView.countStats(diff);

      if (state.titleComponent && state.path !== undefined) {
        DiffView.buildTitle({
          label: "Edit",
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
