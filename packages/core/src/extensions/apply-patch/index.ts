import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { computeActiveTools } from "./coordinator";
import { applyPatch, formatApplySummary } from "./executor";
import { isGptModel } from "./model";
import { parsePatch } from "./parser";
import { applyPatchView } from "./render";
import {
  type ApplyPatchInput,
  applyPatchSchema,
  prepareApplyPatchArguments,
} from "./schema";

const ERROR_PREVIEW_LINES = 12;

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
    // A patch that will not parse cannot be bounded, and `parsePatch` throwing
    // is exactly how the caller learns that.
    effect: {
      kind: "writesPaths",
      paths: ({ input }) =>
        parsePatch(input).hunks.flatMap((hunk) =>
          hunk.kind === "update" && hunk.movePath
            ? [hunk.path, hunk.movePath]
            : [hunk.path]
        ),
    },
    executionMode: "sequential",
    previewLines: ERROR_PREVIEW_LINES,
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
    toViewModel: applyPatchView,
  });

  const reconcile = (isGpt: boolean): void => {
    const active = pi.getActiveTools();
    const available = pi.getAllTools().map((tool) => tool.name);
    const next = computeActiveTools(available, active, isGpt);
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
