import type { ToolDiffHunk } from "../DiffLines";

/**
 * The diff hunk shape produced by `DiffLines.buildToolDiff`. Aliased rather
 * than redefined so a `diff` block is spreadable straight from a `ToolDiff`
 * (`{ kind: "diff", ...diff }`) and stays paintable by `DiffRenderer`.
 */
export type DiffHunk = ToolDiffHunk;

export type TextTone = "default" | "muted" | "error";

export type NoticeSeverity = "info" | "warn" | "error";

export type ViewBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: TextTone }
  | {
      readonly kind: "code";
      readonly lang: string;
      readonly text: string;
      readonly startLine?: number;
    }
  | {
      readonly kind: "diff";
      readonly path: string;
      readonly hunks: readonly DiffHunk[];
    }
  | {
      readonly kind: "file";
      readonly path: string;
      /** An undefined end is an open-ended range (`:40`), not a missing one. */
      readonly range?: readonly [number, number | undefined];
      readonly truncated?: boolean;
    }
  | {
      readonly kind: "list";
      readonly items: readonly ViewBlock[];
      readonly ordered?: boolean;
    }
  | {
      readonly kind: "kv";
      readonly pairs: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | {
      readonly kind: "notice";
      readonly text: string;
      readonly severity: NoticeSeverity;
    };

export type ToolView = {
  /**
   * Display label for the title row, e.g. `"Read"`. Defaults to the
   * definition's `label`, which stays lowercase pi-facing metadata.
   */
  readonly label?: string;
  /** Painted as one line: blocks are joined with a single space. */
  readonly title: readonly ViewBlock[];
  readonly body?: readonly ViewBlock[];
  /** `false` forces the body open even when the row is not expanded. */
  readonly collapsed?: boolean;
};
