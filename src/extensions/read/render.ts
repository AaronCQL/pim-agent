import { Paths } from "../../shared/Paths";
import type { ToolView, ViewBlock } from "../../shared/view/ViewBlock";
import type { ReadInput } from "./schema";

type ReadResultLike = {
  readonly content?: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
  readonly details?: unknown;
};

export type ReadViewInput = {
  /** Partially streamed while the call is in flight; every field is optional. */
  readonly args: Partial<ReadInput> | undefined;
  readonly result?: ReadResultLike;
  readonly cwd: string;
};

export function readView({ args, result, cwd }: ReadViewInput): ToolView {
  const input = args ?? {};
  return {
    label: "Read",
    title: [titleBlock(input, result?.details, cwd)],
    body: [{ kind: "text", text: bodyText(result) }],
  };
}

function titleBlock(
  input: Partial<ReadInput>,
  details: unknown,
  cwd: string
): ViewBlock {
  const path = Paths.titleOr(input.path, cwd);
  const visible = visibleRange(details);

  if (visible) {
    return { kind: "file", path, range: visible };
  }

  if (input.start === undefined && input.end === undefined) {
    return { kind: "file", path };
  }

  return { kind: "file", path, range: [input.start ?? 1, input.end] };
}

/**
 * The settled range wins over the requested one so an overlarge `end` (or a
 * byte-capped read) reports what was actually shown.
 */
function visibleRange(details: unknown): readonly [number, number] | undefined {
  if (typeof details !== "object" || details === null) {
    return undefined;
  }

  const { visibleStart, visibleEnd } = details as {
    readonly visibleStart?: unknown;
    readonly visibleEnd?: unknown;
  };

  return typeof visibleStart === "number" && typeof visibleEnd === "number"
    ? [visibleStart, visibleEnd]
    : undefined;
}

function bodyText(result: ReadResultLike | undefined): string {
  const first = result?.content?.[0];
  return first?.text ?? "";
}
