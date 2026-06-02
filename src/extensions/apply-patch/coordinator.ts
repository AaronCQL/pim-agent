const EDIT_TOOL = "edit";
const APPLY_PATCH_TOOL = "apply_patch";

/**
 * Pure reconcile over the active-tool list. Single-slot swap:
 *  - If neither `edit` nor `apply_patch` is active, no-op (respect user opt-out).
 *  - Otherwise keep exactly one in the same position: `apply_patch` when the
 *    model is GPT/Codex-family, else `edit`. All other active tools are
 *    preserved in order.
 *
 * Returns the same array reference when nothing changes so callers can skip the
 * prompt-rebuilding `setActiveTools` call.
 */
export function computeActiveTools(
  active: readonly string[],
  isGpt: boolean
): readonly string[] {
  const hasEdit = active.includes(EDIT_TOOL);
  const hasApplyPatch = active.includes(APPLY_PATCH_TOOL);

  if (!hasEdit && !hasApplyPatch) {
    return active;
  }

  const desired = isGpt ? APPLY_PATCH_TOOL : EDIT_TOOL;
  const drop = isGpt ? EDIT_TOOL : APPLY_PATCH_TOOL;

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
