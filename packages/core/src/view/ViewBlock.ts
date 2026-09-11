import type { ToolDiffHunk } from "../shared/DiffLines";

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
  | "warning"
  | "accent"
  | "added"
  | "removed"
  | "title";

/**
 * Semantic icon names, mapped by each painter to whatever glyph vocabulary the
 * surface owns: an emoji in Telegram, an icon class on the web, nothing at all
 * in a terminal that already prefixes every row with a marker.
 */
export type ToolIcon =
  | "file"
  | "edit"
  | "trash"
  | "terminal"
  | "search"
  | "checklist"
  | "globe"
  | "upload"
  | "clock"
  | "robot";

/** A run of text carrying one tone. The only inline primitive. */
export type Span = {
  readonly text: string;
  readonly tone?: Tone;
  /** Superseded content, e.g. the old half of a rename. */
  readonly strike?: boolean;
  /** Emphasis, e.g. the one todo a call put in progress. */
  readonly strong?: boolean;
  /**
   * Inline code, e.g. a shell command inside a sentence. The ANSI painter
   * ignores it: a terminal is already monospace, so a code span there would
   * only add colour the title never had.
   */
  readonly code?: boolean;
};

export type NoticeSeverity = "info" | "warn" | "error";

export type ViewBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: Tone }
  /**
   * Markdown source, painted by whichever markdown renderer the surface owns.
   * It wraps at the render-time width and emits its own SGR, so it is framed
   * as an embed and never re-coloured or re-wrapped by the gutter.
   */
  | { readonly kind: "markdown"; readonly text: string }
  /** One line of mixed-tone text, e.g. a `+5`/`-2` diff stat or a rename. */
  | { readonly kind: "spans"; readonly spans: readonly Span[] }
  /**
   * Introduces a sub-item inside a body, e.g. the second file of a patch.
   * Painters render it as a heading and separate it from what precedes it.
   * Its content is blocks rather than spans so a sub-item keeps the structure
   * a title has — a `file` path stays a path, stats stay stats.
   */
  | {
      readonly kind: "section";
      readonly label: string;
      readonly icon?: ToolIcon;
      readonly content: readonly ViewBlock[];
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
  /**
   * A file the agent handed to whoever is reading, already stored somewhere
   * the reader's client can fetch it from.
   *
   * Distinct from `file`, which names a path *on the agent's machine* — that
   * is a subject, this is a delivery. `url` is server-relative for the same
   * reason `AttachmentView`'s is: where the server is reachable is the
   * client's own business. A surface that cannot fetch it — a terminal, a
   * chat on another host — draws the name, which is the whole of what it can
   * honestly say.
   */
  | {
      readonly kind: "attachment";
      /** What to call it on screen; never a path. */
      readonly name: string;
      readonly url: string;
      readonly isImage: boolean;
    }
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
  /** Tints the label; defaults to the title colour. */
  readonly labelTone?: Tone;
  /** Glyph for surfaces that lead a tool row with one. */
  readonly icon?: ToolIcon;
  /**
   * Painted as one line: blocks are joined with a single space. A single
   * `markdown` block is instead handed to the title renderer unpainted, since
   * markdown can only wrap once the width is known.
   */
  readonly title: readonly ViewBlock[];
  /**
   * Status content that renders in every state: while the call is still
   * streaming, while collapsed, and while expanded. A streaming tool needs a
   * persistent status line next to a payload worth hiding, and that split is
   * also what a collapsed tool card wants in a non-terminal client, so it
   * belongs to the view rather than to a terminal-only affordance.
   */
  readonly summary?: readonly ViewBlock[];
  /** Rendered only once the row is expanded, and never while streaming. */
  readonly body?: readonly ViewBlock[];
};
