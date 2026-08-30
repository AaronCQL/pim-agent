import type { ToolViewInput } from "../../shared/Tools";
import { DiffBlocks } from "../../view/DiffBlocks";
import type { ToolView } from "../../view/ViewBlock";
import type { writeSchema } from "./schema";
import type { WriteOutcome } from "./write";

type WriteViewInput = ToolViewInput<typeof writeSchema, WriteOutcome>;

export function writeView({ args, result, cwd }: WriteViewInput): ToolView {
  return DiffBlocks.fileView({
    label: "Write",
    path: typeof args?.path === "string" ? args.path : undefined,
    cwd,
    diff: result?.details?.diff,
  });
}
