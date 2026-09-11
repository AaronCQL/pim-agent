/**
 * The diff wire shape. Declared beside the git that produces it, the way
 * `GitBranch` and `ToolView` are, and named here so the two commands that
 * carry it read as protocol.
 */
export type {
  ChangeList,
  ChangeStatus,
  ChangeSummary,
  DiffBase,
  FileDiff,
} from "#core/shared/RepoDiff";
