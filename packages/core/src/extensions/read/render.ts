import { Paths } from "../../shared/Paths";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import { Painting } from "../../view/Painting";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type { ReadDetails, ReadInput, readSchema } from "./schema";

export type ReadViewInput = ToolViewInput<typeof readSchema, ReadDetails>;

export function readView({ args, result, cwd }: ReadViewInput): ToolView {
  const input: Partial<ReadInput> = args ?? {};
  const details = result?.details;
  const image = details?.kind === "image" ? details : undefined;
  const path = Paths.titleOr(input.path, cwd);
  return {
    label: "Read",
    icon: "file",
    title: [image ? { kind: "file", path } : titleBlock(input, details, path)],
    body: image
      ? Painting.imageBlocks(
          image,
          path,
          image.deduped ? [["reused", "unchanged since the earlier read"]] : []
        )
      : [{ kind: "text", text: Renderer.firstText(result) }],
  };
}

function titleBlock(
  input: Partial<ReadInput>,
  details: ReadDetails | undefined,
  path: string
): ViewBlock {
  const visible = visibleRange(details);

  if (visible) {
    return { kind: "file", path, range: visible };
  }

  if (input.start === undefined && input.end === undefined) {
    return { kind: "file", path };
  }

  return { kind: "file", path, range: [input.start ?? 1, input.end] };
}

/** Legacy sessions predate the tag, so an untagged result is read for the range it may still carry. */
function visibleRange(
  details: ReadDetails | undefined
): readonly [number, number] | undefined {
  if (details === undefined || details.kind === "image") {
    return undefined;
  }
  const { visibleStart, visibleEnd } = details;
  return typeof visibleStart === "number" && typeof visibleEnd === "number"
    ? [visibleStart, visibleEnd]
    : undefined;
}
