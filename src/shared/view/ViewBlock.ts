import type { ToolDiffHunk } from "../DiffLines";

/**
 * The diff hunk shape produced by `DiffLines.buildToolDiff`. Aliased rather
 * than redefined so a `diff` block is spreadable straight from a `ToolDiff`
 * (`{ kind: "diff", ...diff }`) and stays paintable by `DiffRenderer`.
 */
export type DiffHunk = ToolDiffHunk;

/**
 * Inline styling roles, kept semantic rather than visual: the ANSI painter
 * maps them to theme colours, a Markdown painter to inline wrappers, an HTML
 * painter to classes. Every painter must map the whole set.
 */
export type Tone =
  | "default"
  | "muted"
  | "dim"
  | "error"
  | "added"
  | "removed"
  | "title";

/** A run of text carrying one tone. The only inline primitive. */
export type Span = {
  readonly text: string;
  readonly tone?: Tone;
  /** Superseded content, e.g. the old half of a rename. */
  readonly strike?: boolean;
};

export type NoticeSeverity = "info" | "warn" | "error";

export type ViewBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: Tone }
  /** One line of mixed-tone text, e.g. a `+5`/`-2` diff stat or a rename. */
  | { readonly kind: "spans"; readonly spans: readonly Span[] }
  /**
   * Introduces a sub-item inside a body, e.g. the second file of a patch.
   * Painters render it as a heading and separate it from what precedes it.
   */
  | {
      readonly kind: "section";
      readonly label: string;
      readonly content: readonly Span[];
    }
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
