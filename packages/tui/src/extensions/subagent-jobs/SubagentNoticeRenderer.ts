import type {
  MessageRenderer,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import { SubagentNotice } from "#core/extensions/subagent/SubagentNotice";

type Message = Parameters<MessageRenderer>[0];

/** A `subagent_notice` message, as one muted line. */
function render(
  message: Message,
  options: MessageRenderOptions,
  theme: Theme
): Component | undefined {
  const details = SubagentNotice.detailsOf(message);
  return details === undefined
    ? undefined
    : new Text(
        theme.fg("muted", SubagentNotice.line(details)),
        options.outputPad,
        0
      );
}

export const SubagentNoticeRenderer = { render };
