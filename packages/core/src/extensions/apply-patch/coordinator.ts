const EDIT_TOOL = "edit";
const APPLY_PATCH_TOOL = "apply_patch";

/**
 * Pure reconcile over available and active tool lists. Single-slot swap:
 *  - If exactly one of `edit` or `apply_patch` is available, use that tool.
 *  - If both are available, keep exactly one in the same position: `apply_patch`
 *    when the model is GPT/Codex-family, else `edit`.
 *  - If neither is active and availability does not force a choice, no-op
 *    (respect user opt-out). All other active tools are preserved in order.
 *
 * Returns the same array reference when nothing changes so callers can skip the
 * prompt-rebuilding `setActiveTools` call.
 */
export function computeActiveTools(
  available: readonly string[],
  active: readonly string[],
  isGpt: boolean
): readonly string[] {
  const hasEdit = active.includes(EDIT_TOOL);
  const hasApplyPatch = active.includes(APPLY_PATCH_TOOL);
  const canEdit = available.includes(EDIT_TOOL);
  const canApplyPatch = available.includes(APPLY_PATCH_TOOL);

  if (!hasEdit && !hasApplyPatch) {
    if (canEdit !== canApplyPatch) {
      return [...active, canEdit ? EDIT_TOOL : APPLY_PATCH_TOOL];
    }
    return active;
  }

  if (!canEdit && !canApplyPatch) {
    return active;
  }

  const desired =
    canEdit && !canApplyPatch
      ? EDIT_TOOL
      : canApplyPatch && !canEdit
        ? APPLY_PATCH_TOOL
        : isGpt
          ? APPLY_PATCH_TOOL
          : EDIT_TOOL;
  const drop = desired === EDIT_TOOL ? APPLY_PATCH_TOOL : EDIT_TOOL;

  if (active.includes(desired) && !active.includes(drop)) {
    return active;
  }

  const result: string[] = [];
  let placed = false;
  for (const tool of active) {
    if (tool === EDIT_TOOL || tool === APPLY_PATCH_TOOL) {
      if (!placed) {
        result.push(desired);
        placed = true;
      }
      continue;
    }
    result.push(tool);
  }
  if (!placed) {
    result.push(desired);
  }

  return result;
}
