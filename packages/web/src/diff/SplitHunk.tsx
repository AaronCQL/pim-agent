import { createMemo, For, Show } from "solid-js";

import type {
  IntraLineRange,
  ToolDiffHunk,
  ToolDiffLine,
  ToolDiffLineKind,
} from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffLayout } from "#core/view/DiffLayout";
import { DiffPairs } from "#core/view/DiffPairs";
import { Highlight, type Token } from "../view/highlight";
import {
  DIFF_EMPHASIS_CLASSES,
  DIFF_GUTTER_CLASSES,
  DIFF_ROW_CLASSES,
  syntaxClass,
} from "../view/tokens";

type Tokens = ReadonlyMap<ToolDiffLine, readonly Token[] | undefined>;

type Side = "old" | "new";

const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLineKind, string>;

/** Old beside new in one grid, so no scroll or wrap can pull the two columns apart. */
export function SplitDiff(props: {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
}) {
  const lang = createMemo(() => Languages.fromPath(props.path));
  const width = createMemo(() => DiffLayout.gutterWidth(props.hunks));

  return (
    <div class="grid w-max min-w-full grid-cols-[auto_1fr_auto_1fr] leading-[--line] text-neutral-300 [tab-size:3]">
      <For each={props.hunks}>
        {(hunk, index) => (
          <>
            <Show when={index() > 0}>
              <div
                class={`col-span-full whitespace-pre ${DIFF_GUTTER_CLASSES.context}`}
              >
                {`${" ".repeat(width() + 1)}   ⋯`}
              </div>
            </Show>
            <SplitHunk hunk={hunk} lang={lang()} width={width()} />
          </>
        )}
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
  const gutter = (): string => {
    const line = props.line;
    const number = line === undefined ? undefined : DiffLayout.lineNumber(line);
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
        class={`whitespace-pre pr-1ch ${DIFF_ROW_CLASSES[kind()]}`}
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

type Piece = Token & { readonly emphasis?: boolean };

// Syntax tokens re-cut at the emphasis range edges; both count the same characters.
function emphasize(
  tokens: readonly Token[],
  ranges: readonly IntraLineRange[] = []
): readonly Piece[] {
  if (ranges.length === 0) {
    return tokens;
  }

  const edges = ranges.flatMap((range) => [range.start, range.end]);
  const pieces: Piece[] = [];
  let at = 0;

  for (const token of tokens) {
    const end = at + token.text.length;
    const stops = [
      ...new Set(edges.filter((edge) => edge > at && edge < end)),
      end,
    ].sort((first, second) => first - second);
    let cut = at;

    for (const stop of stops) {
      const text = token.text.slice(cut - at, stop - at);
      if (text !== "") {
        pieces.push({
          text,
          role: token.role,
          emphasis: ranges.some(
            (range) => cut >= range.start && cut < range.end
          ),
        });
      }
      cut = stop;
    }

    at = end;
  }

  return pieces;
}
