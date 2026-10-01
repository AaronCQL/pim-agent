import type { ToolDiffHunk } from "../shared/DiffLines";
import type { ImageMimeType } from "../shared/Images";

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

export type KvPair = readonly [string, string];

export type ViewBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: Tone }
  /** Never re-coloured or re-wrapped. */
  | { readonly kind: "markdown"; readonly text: string }
  /** One line of mixed-tone text, e.g. a `+5`/`-2` diff stat. */
  | { readonly kind: "spans"; readonly spans: readonly Span[] }
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
      /** An undefined end means open-ended (`:40`). */
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
      readonly pairs: readonly KvPair[];
    }
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | {
      readonly kind: "attachment";
      /** Display name, never a path. */
      readonly name: string;
      /** Server-relative. */
      readonly url: string;
      readonly isImage: boolean;
    }
  /** An image the model saw, addressed by digest; the client builds the URL. */
  | {
      readonly kind: "image";
      readonly sha256: string;
      readonly mimeType: ImageMimeType;
      readonly width: number;
      readonly height: number;
      readonly bytes: number;
      readonly alt: string;
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
  /** Defaults to the tool definition's label. */
  readonly label?: string;
  /** Defaults to the title colour. */
  readonly labelTone?: Tone;
  readonly icon?: ToolIcon;
  /** Painted as one line; a lone `markdown` block is passed through unpainted. */
  readonly title: readonly ViewBlock[];
  /** Shown in every state, including streaming. */
  readonly summary?: readonly ViewBlock[];
  /** Shown only when expanded, never while streaming. */
  readonly body?: readonly ViewBlock[];
};
