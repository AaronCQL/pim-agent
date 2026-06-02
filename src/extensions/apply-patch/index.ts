import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffRenderState } from "../../shared/DiffView";
import { Tools } from "../../shared/Tools";
import { computeActiveTools } from "./coordinator";
import { applyPatch, formatApplySummary } from "./executor";
import { isGptModel } from "./model";
import { parsePatch } from "./parser";
import { renderApplyPatchCall, renderApplyPatchResult } from "./render";
import {
  type ApplyPatchInput,
  applyPatchSchema,
  prepareApplyPatchArguments,
} from "./schema";

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "apply_patch",
    label: "Edit",
    description:
      "Apply a V4A patch to create, edit, delete, or move UTF-8 text files. " +
      "Edits must be unique; include enough surrounding context for uniqueness. " +
      "Prefer apply_patch over write for changes to existing files.",
    parameters: applyPatchSchema,
    prepareArguments: prepareApplyPatchArguments,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { input } = params as ApplyPatchInput;

      if (signal?.aborted) {
        throw new Error("apply_patch aborted before execution.");
      }

      const patch = parsePatch(input);
      const outcome = await applyPatch(patch, ctx.cwd);

      return {
        content: [{ type: "text", text: formatApplySummary(outcome) }],
        details: { entries: outcome.entries },
      };
    },
    renderCall(args, theme, context) {
      return renderApplyPatchCall(
        args as Record<string, unknown> | undefined,
        theme,
        context as typeof context & { state: DiffRenderState }
      );
    },
    renderResult(result, options, theme, context) {
      return renderApplyPatchResult(
        result,
        options,
        theme,
        context as typeof context & { state: DiffRenderState }
      );
    },
  });

  const reconcile = (isGpt: boolean): void => {
    const active = pi.getActiveTools();
    const next = computeActiveTools(active, isGpt);
    if (next !== active) {
      pi.setActiveTools([...next]);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    reconcile(isGptModel(ctx.model));
  });

  pi.on("model_select", (event) => {
    reconcile(isGptModel(event.model));
  });
}
