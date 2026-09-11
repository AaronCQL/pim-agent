import type { ToolDiffHunk } from "../shared/DiffLines";

export type DiffHunk = ToolDiffHunk;

/** Semantic inline styling roles; every painter must map the whole set. */
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

export type Span = {
  readonly text: string;
  readonly tone?: Tone;
  readonly strike?: boolean;
  readonly strong?: boolean;
  readonly code?: boolean;
};

export type NoticeSeverity = "info" | "warn" | "error";

export type ViewBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: Tone }
  /** Markdown source; framed as an embed and never re-coloured or re-wrapped. */
  | { readonly kind: "markdown"; readonly text: string }
  /** One line of mixed-tone text, e.g. a `+5`/`-2` diff stat or a rename. */
  | { readonly kind: "spans"; readonly spans: readonly Span[] }
  /** Introduces a sub-item inside a body; painters draw it as a separated heading. */
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
  /** A file delivered to the reader, not a path on the agent's machine; `url` is server-relative. */
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

export type BlockOf<TKind extends ViewBlock["kind"]> = Extract<
  ViewBlock,
  { kind: TKind }
>;

export type ToolView = {
  /** Display label for the title row, e.g. `"Read"`; defaults to the definition's label. */
  readonly label?: string;
  /** Tints the label; defaults to the title colour. */
  readonly labelTone?: Tone;
  readonly icon?: ToolIcon;
  /** Painted as one line; a lone `markdown` block is handed over unpainted instead. */
  readonly title: readonly ViewBlock[];
  /** Status content rendered in every state: streaming, collapsed and expanded. */
  readonly summary?: readonly ViewBlock[];
  /** Rendered only once the row is expanded, and never while streaming. */
  readonly body?: readonly ViewBlock[];
};
