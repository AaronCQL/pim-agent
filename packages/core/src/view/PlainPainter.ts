import { Painting, type PainterMap } from "./Painting";
import type { ToolView, ViewBlock } from "./ViewBlock";

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
}

/** Blocks as one line of unstyled text. */
function inline(blocks: readonly ViewBlock[]): string {
  return blocks
    .map((block) => Painting.dispatch(PAINTERS, block))
    .filter((text) => text !== "")
    .join(" ");
}

/** A tool row's head as plain text, e.g. `Read src/app.ts:1-40`. */
function toolTitle(view: ToolView): string {
  return [view.label ?? "", inline(view.title)]
    .filter((part) => part !== "")
    .join(" ");
}

const PAINTERS: PainterMap<string> = {
  text: (block) => firstLine(block.text),
  markdown: (block) => firstLine(block.text),
  spans: (block) => firstLine(block.spans.map((span) => span.text).join("")),
  section: (block) => inline(block.content),
  code: (block) => firstLine(block.text),
  diff: (block) => block.path,
  file: (block) => {
    const suffix = Painting.fileSuffix(block);
    return `${block.path}${suffix.range}${suffix.truncated}`;
  },
  list: (block) => inline(block.items),
  kv: (block) =>
    block.pairs.map(([key, value]) => `${key}: ${value}`).join(" "),
  link: (block) => Painting.linkLabel(block),
  attachment: (block) => block.name,
  image: (block) => Painting.imageSummary(block),
  notice: (block) => firstLine(block.text),
};

export const PlainPainter = { inline, toolTitle };
