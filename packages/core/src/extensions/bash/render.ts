import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView } from "../../view/ViewBlock";
import type { BashDetails, bashSchema } from "./schema";

type BashViewInput = ToolViewInput<typeof bashSchema, BashDetails>;

/**
 * A failed command throws, so the renderer routes exit codes, signals, timeout
 * and abort notices through the bordered error path; everything reaching the
 * body here is a clean run, whose text `formatResult` already shaped for the
 * model. The view therefore only has a command to title and that text to show.
 */
export function bashView({ args, result }: BashViewInput): ToolView {
  return {
    label: "Bash",
    icon: "terminal",
    // A `text` block would be split on newlines and rejoined with a space when
    // the title blocks are flattened; `spans` keeps a heredoc or a multi-line
    // pipeline intact for the title component to wrap and indent itself.
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
