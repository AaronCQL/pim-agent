import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DiffRenderState, DiffView } from "../../shared/DiffView";
import { Paths } from "../../shared/Paths";
import { Tools } from "../../shared/Tools";
import { editFile, formatEditSummary } from "./edit";
import { type EditInput, editSchema } from "./schema";

const ERROR_PREVIEW_LINES = 12;

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "edit",
    label: "edit",
    description:
      "Replace strings in a UTF-8 text file. " +
      "Prefer edit over write for changes to existing files.",
    parameters: editSchema,
    renderShell: "self",
    executionMode: "sequential",
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
      const rawPath = typeof args?.path === "string" ? args.path : undefined;
      return DiffView.renderDiffCall({
        label: "Edit",
        rawPath,
        theme,
        context: context as typeof context & { state: DiffRenderState },
      });
    },
    renderResult(result, options, theme, context) {
      return DiffView.renderDiffResult({
        label: "Edit",
        result,
        options,
        theme,
        context: context as typeof context & { state: DiffRenderState },
        previewLines: ERROR_PREVIEW_LINES,
      });
    },
  });
}
