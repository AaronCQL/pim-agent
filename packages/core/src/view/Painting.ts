import type { ViewBlock } from "./ViewBlock";

/**
 * How a block sits relative to the container a body is drawn in. `flow` is
 * ordinary output the container may restyle and re-wrap; `embed` is
 * preformatted and already styled, so the container must leave it alone;
 * `tight` is terminal-only — the block paints its own leading column, so the
 * gutter gives that column up; `heading` steps outside the container to
 * introduce a sub-item.
 */
export type BlockFrame = "flow" | "embed" | "tight" | "heading";

/** The frame each block kind takes on a surface with no gutter to defer to. */
const FRAMES = {
  text: "flow",
  markdown: "embed",
  spans: "flow",
  section: "heading",
  code: "embed",
  diff: "embed",
  file: "flow",
  list: "flow",
  kv: "flow",
  link: "flow",
  notice: "flow",
} as const satisfies Record<ViewBlock["kind"], BlockFrame>;

export type FrameGroup<TFrame> = {
  readonly frame: TFrame;
  readonly blocks: readonly ViewBlock[];
};

/**
 * Runs of consecutive same-frame blocks, so a caller draws one container per
 * run instead of one per block. A frame `mergeable` rejects keeps one block
 * per group even mid-run — a heading is a sub-item's own boundary, and an
 * ANSI markdown embed travels as a single source payload.
 */
function groupByFrame<TFrame>(
  blocks: readonly ViewBlock[],
  frames: Readonly<Record<ViewBlock["kind"], TFrame>>,
  mergeable: (frame: TFrame) => boolean = () => true
): FrameGroup<TFrame>[] {
  const groups: Array<{ frame: TFrame; blocks: ViewBlock[] }> = [];
  for (const block of blocks) {
    const frame = frames[block.kind];
    const open = groups.at(-1);
    if (open?.frame === frame && mergeable(frame)) {
      open.blocks.push(block);
    } else {
      groups.push({ frame, blocks: [block] });
    }
  }
  return groups;
}

/** The `:12` / `:12-40` suffix a `file` block's range paints as. */
function formatRange(range: readonly [number, number | undefined]): string {
  const [start, end] = range;
  return end === undefined ? `:${start}` : `:${start}-${end}`;
}

export const Painting = { FRAMES, groupByFrame, formatRange };
