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
import {
  lineNumberOf,
  type AnchorState,
  type DiffAnchors,
  type DiffSide,
} from "../view/anchors";
import { emphasize, type Piece } from "../view/Blocks";
import { DiffGutter, gutterText } from "../view/DiffGutter";
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

/** The nearest numbered lines above and below a row on its side. */
type Bridge = { readonly above?: number; readonly below?: number };

const DIVIDER = "border-l border-neutral-850";

function lineOf(pair: DiffPair, side: DiffSide): ToolDiffLine | undefined {
  return side === "old" ? pair.left : pair.right;
}

/** Lets a filler between two held lines show as held too. */
function bridges(
  pairs: readonly DiffPair[],
  side: DiffSide
): readonly Bridge[] {
  const numbers = pairs.map((pair) => lineNumberOf(lineOf(pair, side), side));
  const above: (number | undefined)[] = [];
  const below: (number | undefined)[] = [];
  let last: number | undefined;
  for (const [index, number] of numbers.entries()) {
    above[index] = last;
    last = number ?? last;
  }
  last = undefined;
  for (let index = numbers.length - 1; index >= 0; index -= 1) {
    below[index] = last;
    last = numbers[index] ?? last;
  }
  return numbers.map((_, index) => ({
    above: above[index],
    below: below[index],
  }));
}

/** One grid for both sides so the columns stay aligned; long lines wrap within their half. */
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

function SplitHunk(props: {
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

  const tokens = createMemo<Tokens>(() => {
    const mapped = DiffLayout.mapSides(props.hunk.lines, (block) =>
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

/** Each side's cards sit under that side; gutters carry the held wash but no hatch. */
function CommentRow(props: {
  readonly pair: DiffPair;
  readonly anchors: DiffAnchors;
}) {
  const oldLine = (): number | undefined =>
    lineNumberOf(props.pair.left, "old");
  const newLine = (): number | undefined =>
    lineNumberOf(props.pair.right, "new");
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
  const number = (): number | undefined => lineNumberOf(props.line, props.side);
  const held = (line: number | undefined): boolean =>
    props.anchors?.stateOf(props.side, line) === "held";
  // A filler is held when the lines on both sides of it are.
  const state = (): AnchorState => {
    const inside =
      props.line === undefined
        ? held(props.bridge?.above) && held(props.bridge?.below)
        : held(number());
    return inside ? "held" : "idle";
  };
  const row = (): string =>
    props.line === undefined ? DIFF_FILLER_CLASS : DIFF_ROW_CLASSES[kind()];
  const frame = (target: boolean): string =>
    `${diffGutterClass(kind(), state(), target)} ${props.side === "new" ? DIVIDER : ""}`;
  const target = ():
    | { readonly line: ToolDiffLine; readonly anchors: DiffAnchors }
    | undefined => {
    const line = props.line;
    const anchors = props.anchors;
    return line === undefined || anchors === undefined
      ? undefined
      : { line, anchors };
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
      <Show
        when={target()}
        fallback={
          <span class={`select-none whitespace-pre ${frame(false)}`}>
            {gutterText(props.line, props.side, props.width)}
          </span>
        }
      >
        {(held) => (
          <DiffGutter
            line={held().line}
            side={props.side}
            width={props.width}
            anchors={held().anchors}
            class={`flex items-start whitespace-pre text-left ${frame(true)}`}
          />
        )}
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
