import { createMemo, For } from "solid-js";

import type {
  ToolDiffHunk,
  ToolDiffLine,
  ToolDiffLineKind,
} from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DiffLayout } from "#core/view/DiffLayout";
import { DiffPairs } from "#core/view/DiffPairs";
import { emphasize, type Piece } from "../view/Blocks";
import { Highlight, type Token } from "../view/highlight";
import {
  DIFF_FILLER_CLASS,
  DIFF_EMPHASIS_CLASSES,
  DIFF_GUTTER_CLASSES,
  DIFF_ROW_CLASSES,
  syntaxClass,
} from "../view/tokens";
import { GapRow } from "./GapRow";

type Tokens = ReadonlyMap<ToolDiffLine, readonly Token[] | undefined>;

type Side = "old" | "new";

const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLineKind, string>;

/**
 * Old beside new in one grid, so no scroll or wrap can pull the two columns
 * apart. The two text columns are `minmax(0, 1fr)`: each pane keeps half the
 * width whatever its longest line, which a long line then wraps inside rather
 * than widening its side of the pair.
 */
export function SplitDiff(props: {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
  readonly total?: number;
  readonly busy?: boolean;
  readonly onOpen?: (gap: DiffGap) => void;
}) {
  const lang = createMemo(() => Languages.fromPath(props.path));
  const width = createMemo(() => DiffLayout.gutterWidth(props.hunks));
  const parts = createMemo(() => DiffExpand.parts(props.hunks, props.total));
  const open = (gap: DiffGap): void => {
    props.onOpen?.(gap);
  };

  return (
    <div class="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] leading-[--line] text-neutral-300 [tab-size:3]">
      <For each={parts()}>
        {(part) =>
          "gap" in part ? (
            <GapRow
              gap={part.gap}
              width={width()}
              split={true}
              busy={props.busy === true}
              onOpen={open}
            />
          ) : (
            <SplitHunk hunk={part.hunk} lang={lang()} width={width()} />
          )
        }
      </For>
    </div>
  );
}

export function SplitHunk(props: {
  readonly hunk: ToolDiffHunk;
  readonly lang: string | undefined;
  readonly width: number;
}) {
  const pairs = createMemo(() => DiffPairs.pair(props.hunk));

  // One tokenisation per side of the hunk, keyed by the line it belongs to.
  const tokens = createMemo<Tokens>(() => {
    const mapped = DiffLayout.mapSides(props.hunk, (block) =>
      Highlight.tokenize(block, props.lang)
    );
    return new Map(
      props.hunk.lines.map((line, index) => [line, mapped[index]])
    );
  });

  return (
    <For each={pairs()}>
      {(pair) => (
        <>
          <SplitCell
            line={pair.left}
            side="old"
            tokens={tokens()}
            width={props.width}
          />
          <SplitCell
            line={pair.right}
            side="new"
            tokens={tokens()}
            width={props.width}
          />
        </>
      )}
    </For>
  );
}

function SplitCell(props: {
  readonly line: ToolDiffLine | undefined;
  readonly side: Side;
  readonly tokens: Tokens;
  readonly width: number;
}) {
  const kind = (): ToolDiffLineKind => props.line?.kind ?? "context";
  // A half the other side has no counterpart for: shaded, never an empty line.
  // Only the text column is hatched — see the note on the class — so the
  // gutter of a filler is left on the page, numberless and untinted.
  const row = (): string =>
    props.line === undefined ? DIFF_FILLER_CLASS : DIFF_ROW_CLASSES[kind()];
  const gutter = (): string => {
    // Each half counts in its own file: the old side numbers the old, the new the new.
    const number =
      props.side === "old" ? props.line?.oldLine : props.line?.newLine;
    return ` ${String(number ?? "").padStart(props.width)} ${SIGNS[kind()]} `;
  };
  const pieces = (): readonly Piece[] => {
    const line = props.line;
    if (line === undefined) {
      return [];
    }
    return emphasize(
      props.tokens.get(line) ?? [{ text: line.text }],
      line.emphasis
    );
  };

  return (
    <>
      <span
        class={`select-none whitespace-pre ${DIFF_ROW_CLASSES[kind()]} ${DIFF_GUTTER_CLASSES[kind()]} ${props.side === "new" ? "border-l border-neutral-850" : ""}`}
      >
        {gutter()}
      </span>
      <span
        data-side={props.side}
        class={`pr-1ch whitespace-pre-wrap wrap-anywhere ${row()}`}
      >
        <For each={pieces()}>
          {(piece) => (
            <span
              class={`${syntaxClass(piece.role)} ${piece.emphasis ? DIFF_EMPHASIS_CLASSES[kind()] : ""}`}
            >
              {piece.text}
            </span>
          )}
        </For>
      </span>
    </>
  );
}
