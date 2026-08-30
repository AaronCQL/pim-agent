import type { ToolViewInput } from "../../shared/Tools";
import { DiffBlocks } from "../../shared/view/DiffBlocks";
import type { ToolView } from "../../shared/view/ViewBlock";
import type { EditOutcome } from "./edit";
import type { editSchema } from "./schema";

type EditViewInput = ToolViewInput<typeof editSchema, EditOutcome>;

export function editView({ args, result, cwd }: EditViewInput): ToolView {
  return DiffBlocks.fileView({
    label: "Edit",
    path: typeof args?.path === "string" ? args.path : undefined,
    cwd,
    diff: result?.details?.diff,
  });
}
