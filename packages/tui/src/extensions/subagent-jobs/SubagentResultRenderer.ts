import type {
  MessageRenderer,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component } from "@earendil-works/pi-tui";

import { JobState } from "#core/extensions/subagent/JobState";
import { subagentResultView } from "#core/extensions/subagent/render";
import type { SubagentResultDetails } from "#core/extensions/subagent/SubagentResult";
import { MessageText } from "#core/session/MessageText";
import { Renderer } from "#core/shared/Renderer";
import { AnsiPainter } from "#core/view/AnsiPainter";
import { BodyRenderer } from "#core/view/BodyRenderer";

type Message = Parameters<MessageRenderer<SubagentResultDetails>>[0];

/** A `subagent_result` message, laid out like a subagent tool row. */
function render(
  message: Message,
  options: MessageRenderOptions,
  theme: Theme
): Component | undefined {
  const details = message.details;
  if (details === undefined) {
    return undefined;
  }
  const view = subagentResultView({
    content: MessageText.textOf(message.content),
    details,
  });
  const context = {
    lastComponent: undefined,
    isPartial: false,
    isError: JobState.isError(details.state),
  };
  const title = AnsiPainter.paintTitle(view.title, theme);
  const box = new Box(options.outputPad, 0);
  box.addChild(
    Renderer.renderToolCallTitle({
      label: view.label ?? "Subagent",
      title: title.text,
      markdown: title.markdown,
      labelColor: AnsiPainter.themeColorFor(view.labelTone),
      theme,
      context,
    })
  );
  box.addChild(
    BodyRenderer.render({
      summary: view.summary,
      body: view.body,
      options: { expanded: options.expanded, isPartial: false },
      theme,
      context,
    })
  );
  return box;
}

export const SubagentResultRenderer = { render };
