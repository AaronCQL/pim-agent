import { createMemo, For, Show } from "solid-js";

import type {
  ToolDiffHunk,
  ToolDiffLine,
  ToolDiffLineKind,
} from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import { DiffLayout } from "#core/view/DiffLayout";
import { DiffPairs, type DiffPair } from "#core/view/DiffPairs";
import type { AnchorState, DiffAnchors, DiffSide } from "../view/anchors";
import { emphasize, type Piece } from "../view/Blocks";
import { Highlight, type Token } from "../view/highlight";
import {
  DIFF_FILLER_CLASS,
  DIFF_EMPHASIS_CLASSES,
  DIFF_ANCHOR_CLASSES,
  DIFF_ROW_CLASSES,
  diffGutterClass,
  syntaxClass,
} from "../view/tokens";
import { GapRow } from "./GapRow";

type Tokens = ReadonlyMap<ToolDiffLine, readonly Token[] | undefined>;

/** The numbered lines nearest a filler on its own side: what a range over it runs between. */
type Bridge = { readonly above?: number; readonly below?: number };

const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLineKind, string>;

const DIVIDER = "border-l border-neutral-850";

function numberOf(
  line: ToolDiffLine | undefined,
  side: DiffSide
): number | undefined {
  return side === "old" ? line?.oldLine : line?.newLine;
}

function lineOf(pair: DiffPair, side: DiffSide): ToolDiffLine | undefined {
  return side === "old" ? pair.left : pair.right;
}

/**
 * What lies either side of each row in one column, skipping the fillers, which
 * have no number to be asked about: a filler both its neighbours are held by is
 * inside the range rather than beside it, and wears the wash with them.
 */
function bridges(
  pairs: readonly DiffPair[],
  side: DiffSide
): readonly Bridge[] {
  const numbers = pairs.map((pair) => numberOf(lineOf(pair, side), side));
  const walk = (order: readonly number[]): readonly (number | undefined)[] => {
    const found: (number | undefined)[] = [];
    let last: number | undefined;
    for (const index of order) {
      found[index] = last;
      last = numbers[index] ?? last;
    }
    return found;
  };
  const rows = numbers.map((_, index) => index);
  const above = walk(rows);
  const below = walk([...rows].reverse());
  return rows.map((index) => ({ above: above[index], below: below[index] }));
}

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
  readonly anchors?: DiffAnchors;
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
            <SplitHunk
              hunk={part.hunk}
              lang={lang()}
              width={width()}
              anchors={props.anchors}
            />
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
  readonly anchors?: DiffAnchors;
}) {
  const pairs = createMemo(() => DiffPairs.pair(props.hunk));
  const spans = createMemo(() => ({
    old: bridges(pairs(), "old"),
    new: bridges(pairs(), "new"),
  }));

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
      {(pair, index) => (
        <>
          <SplitCell
            line={pair.left}
            side="old"
            tokens={tokens()}
            width={props.width}
            bridge={spans().old[index()]}
            anchors={props.anchors}
          />
          <SplitCell
            line={pair.right}
            side="new"
            tokens={tokens()}
            width={props.width}
            bridge={spans().new[index()]}
            anchors={props.anchors}
          />
          <Show when={props.anchors}>
            {(anchors) => <CommentRow pair={pair} anchors={anchors()} />}
          </Show>
        </>
      )}
    </For>
  );
}

/**
 * The comments of one pair, each in the text column of the side it was written
 * on: a remark about the old line has no business under the new one. The
 * gutter cells are never hatched — a hatch says this side has no line there,
 * and a comment row is not a line — but they do carry the wash of the line the
 * card hangs off, so the hold reads as one block down to the words in it.
 */
function CommentRow(props: {
  readonly pair: DiffPair;
  readonly anchors: DiffAnchors;
}) {
  const oldLine = (): number | undefined => numberOf(props.pair.left, "old");
  const newLine = (): number | undefined => numberOf(props.pair.right, "new");
  const wash = (side: DiffSide, line: number | undefined): string =>
    props.anchors.stateOf(side, line) === "held"
      ? DIFF_ANCHOR_CLASSES.held
      : "";

  return (
    <Show
      when={
        props.anchors.holdsCards("old", oldLine()) ||
        props.anchors.holdsCards("new", newLine())
      }
    >
      <div class={wash("old", oldLine())} />
      <div>{props.anchors.cardsAt("old", oldLine())}</div>
      <div class={`${DIVIDER} ${wash("new", newLine())}`} />
      <div>{props.anchors.cardsAt("new", newLine())}</div>
    </Show>
  );
}

function SplitCell(props: {
  readonly line: ToolDiffLine | undefined;
  readonly side: DiffSide;
  readonly tokens: Tokens;
  readonly width: number;
  readonly bridge?: Bridge;
  readonly anchors?: DiffAnchors;
}) {
  const kind = (): ToolDiffLineKind => props.line?.kind ?? "context";
  // Each half counts in its own file: the old side numbers the old, the new the new.
  const number = (): number | undefined => numberOf(props.line, props.side);
  const held = (line: number | undefined): boolean =>
    props.anchors?.stateOf(props.side, line) === "held";
  // A filler is numberless, so nothing holds it on its own account; a range
  // that runs past it on both sides does, and the gutter says so unbroken.
  const state = (): AnchorState => {
    const inside =
      props.line === undefined
        ? held(props.bridge?.above) && held(props.bridge?.below)
        : held(number());
    return inside ? "held" : "idle";
  };
  // A half the other side has no counterpart for: shaded, never an empty line.
  // Only the text column is hatched — see the note on the class — so the
  // gutter of a filler is left on the page, numberless and untinted.
  const row = (): string =>
    props.line === undefined ? DIFF_FILLER_CLASS : DIFF_ROW_CLASSES[kind()];
  const gutter = (): string =>
    ` ${String(number() ?? "").padStart(props.width)} ${SIGNS[kind()]} `;
  const frame = (target: boolean): string =>
    `${diffGutterClass(kind(), state(), target)} ${props.side === "new" ? DIVIDER : ""}`;
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
      <Show
        when={props.anchors !== undefined && props.line !== undefined}
        fallback={
          <span class={`select-none whitespace-pre ${frame(false)}`}>
            {gutter()}
          </span>
        }
      >
        <button
          type="button"
          aria-label={`Comment on ${props.side} line ${number() ?? ""}`}
          // See the note in the unified painter: a finger drawn down the gutter
          // is a range rather than a scroll.
          // A button centres its own label, which on a line long enough to wrap
          // floats the number down the middle of the rows it belongs to. Laid
          // out as a flex box instead, the number sits on the first of them
          // while the cell still stretches, so the tint runs the whole height.
          class={`flex items-start select-none [touch-action:pan-x] whitespace-pre text-left ${frame(true)}`}
          onClick={(event) => {
            // A keyboard reports no clicks; the pointer has its own path.
            if (props.line !== undefined && event.detail === 0) {
              props.anchors?.onPick(props.line, props.side, event.shiftKey);
            }
          }}
          onPointerDown={(event) => {
            if (props.line !== undefined && event.button === 0) {
              // No text selection dragged through the code beside the range.
              event.preventDefault();
              // Touch captures the pointer to the element it went down on.
              event.currentTarget.releasePointerCapture(event.pointerId);
              props.anchors?.onPress(props.line, props.side, event.shiftKey);
            }
          }}
          onPointerEnter={(event) => {
            if (props.line !== undefined && event.buttons === 1) {
              props.anchors?.onSweep(props.line, props.side);
            }
          }}
        >
          {gutter()}
        </button>
      </Show>
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
