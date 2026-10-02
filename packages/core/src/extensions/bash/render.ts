import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import { Painting } from "../../view/Painting";
import type { ToolView } from "../../view/ViewBlock";
import type { BashDetails, bashSchema } from "./schema";

type BashViewInput = ToolViewInput<typeof bashSchema, BashDetails>;

export function bashView({ args, result }: BashViewInput): ToolView {
  const command = commandTitle(args?.command);
  const image = result?.details?.image;
  return {
    label: "Bash",
    icon: "terminal",
    // Not `text`: that would join a multi-line command onto one line.
    title: [
      {
        kind: "spans",
        spans: [{ text: command, code: true }],
      },
    ],
    body: [
      ...(image ? Painting.imageBlocks(image, command) : []),
      { kind: "text", text: Renderer.firstText(result) },
    ],
  };
}

function commandTitle(command: unknown): string {
  return typeof command === "string" && command !== "" ? command : "...";
}
