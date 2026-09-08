import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView } from "../../view/ViewBlock";
import type { BashDetails, bashSchema } from "./schema";

type BashViewInput = ToolViewInput<typeof bashSchema, BashDetails>;

export function bashView({ args, result }: BashViewInput): ToolView {
  return {
    label: "Bash",
    icon: "terminal",
    // `spans`, not `text`: a `text` title is split on newlines and rejoined with spaces.
    title: [
      {
        kind: "spans",
        spans: [{ text: commandTitle(args?.command), code: true }],
      },
    ],
    body: [{ kind: "text", text: Renderer.firstText(result) }],
  };
}

function commandTitle(command: unknown): string {
  return typeof command === "string" && command !== "" ? command : "...";
}
