import { Format } from "../shared/Format";
import { ImageMime } from "../shared/ImageMime";
import type { ImageDetails } from "../shared/Images";
import type { BlockOf, KvPair, ViewBlock } from "./ViewBlock";

export type PainterMap<TOut, TArgs extends readonly unknown[] = []> = {
  readonly [TKind in ViewBlock["kind"]]: (
    block: BlockOf<TKind>,
    ...args: TArgs
  ) => TOut;
};

function dispatch<TOut, TArgs extends readonly unknown[]>(
  painters: PainterMap<TOut, TArgs>,
  block: ViewBlock,
  ...args: TArgs
): TOut {
  const painter = painters[block.kind] as (
    block: ViewBlock,
    ...args: TArgs
  ) => TOut;
  return painter(block, ...args);
}

/** How a block sits in its container: `embed` must not be restyled or re-wrapped, `tight` paints its own leading column. */
export type BlockFrame = "flow" | "embed" | "tight" | "heading";

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
  attachment: "flow",
  image: "flow",
  notice: "flow",
} as const satisfies Record<ViewBlock["kind"], BlockFrame>;

/** What a block is to the tool that emitted it: its result, or the chrome around one. */
export type BlockWeight = "payload" | "chrome";

const WEIGHT = {
  text: "chrome",
  markdown: "payload",
  spans: "chrome",
  section: "chrome",
  code: "chrome",
  diff: "payload",
  file: "chrome",
  list: "chrome",
  kv: "chrome",
  link: "chrome",
  attachment: "chrome",
  image: "payload",
  notice: "chrome",
} as const satisfies Record<ViewBlock["kind"], BlockWeight>;

export type FrameGroup<TFrame> = {
  readonly frame: TFrame;
  readonly blocks: readonly ViewBlock[];
};

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

function formatRange(range: readonly [number, number | undefined]): string {
  const [start, end] = range;
  return end === undefined ? `:${start}` : `:${start}-${end}`;
}

function fileSuffix(block: {
  readonly range?: readonly [number, number | undefined];
  readonly truncated?: boolean;
}): { readonly range: string; readonly truncated: string } {
  return {
    range: block.range ? formatRange(block.range) : "",
    truncated: block.truncated === true ? " (truncated)" : "",
  };
}

function linkLabel(block: {
  readonly label: string;
  readonly href: string;
}): string {
  return block.label === "" || block.label === block.href
    ? block.href
    : block.label;
}

/** What a painter that cannot draw the picture says instead: `[image 1200×800 png · 240 KB]`. */
function imageSummary(block: BlockOf<"image">): string {
  return `[image ${block.width}×${block.height} ${ImageMime.extensionOf(block.mimeType)} · ${Format.bytes(block.bytes)}]`;
}

/** The picture plus what it cannot show about itself; `extra` is whatever only the calling tool knows. */
function imageBlocks(
  details: ImageDetails,
  alt: string,
  extra: readonly KvPair[] = []
): readonly ViewBlock[] {
  return [
    {
      kind: "image",
      sha256: details.sha256,
      mimeType: details.mimeType,
      width: details.width,
      height: details.height,
      bytes: details.bytes,
      alt,
    },
    {
      kind: "kv",
      pairs: [
        [
          "dimensions",
          `${details.width}x${details.height}${details.resized ? " (downscaled)" : ""}`,
        ],
        ...(details.frames >= 2
          ? [["frames", `${details.frames} (frame 1 shown)`] as KvPair]
          : []),
        ["size", Format.bytes(details.bytes)],
        ...extra,
      ],
    },
  ];
}

function lineNumberWidth(start: number, count: number): number {
  return String(start + Math.max(0, count - 1)).length;
}

function hangingList(
  items: readonly ViewBlock[],
  ordered: boolean,
  paintItem: (item: ViewBlock) => readonly string[],
  styleMarker: (marker: string) => string = (marker) => marker
): string[] {
  const markers = items.map((_, index) => (ordered ? `${index + 1}.` : "•"));
  const width = Math.max(0, ...markers.map((marker) => marker.length)) + 1;
  const indent = " ".repeat(width);

  return items.flatMap((item, index) => {
    const marker = styleMarker((markers[index] ?? "•").padEnd(width));
    return paintItem(item).map((line, lineIndex) =>
      lineIndex === 0 ? marker + line : indent + line
    );
  });
}

export const Painting = {
  FRAMES,
  WEIGHT,
  dispatch,
  groupByFrame,
  formatRange,
  fileSuffix,
  linkLabel,
  imageSummary,
  imageBlocks,
  lineNumberWidth,
  hangingList,
};
