const EDIT_TOOL = "edit";
const APPLY_PATCH_TOOL = "apply_patch";

/** Keeps at most one of `edit`/`apply_patch` active. Returns `active` itself when nothing changes. */
export function computeActiveTools(
  available: readonly string[],
  active: readonly string[],
  preferApplyPatch: boolean
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
    canApplyPatch && (preferApplyPatch || !canEdit)
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
