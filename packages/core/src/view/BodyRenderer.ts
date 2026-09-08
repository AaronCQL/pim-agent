import type {
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import {
  type PrefixSpec,
  type RenderContext,
  Renderer,
} from "../shared/Renderer";
import { AnsiPainter, type BlockFrame, type PaintedGroup } from "./AnsiPainter";
import type { ViewBlock } from "./ViewBlock";

type FrameBuilder = (group: PaintedGroup, theme: Theme) => Component[];

type FrameBuilders = Record<BlockFrame, FrameBuilder>;

function render(args: {
  readonly summary?: readonly ViewBlock[];
  readonly body?: readonly ViewBlock[];
  readonly options: ToolRenderResultOptions;
  readonly theme: Theme;
  readonly context: RenderContext;
}): Container {
  const { summary, body, options, theme, context } = args;
  const container =
    (context.lastComponent as Container | undefined) ?? new Container();
  container.clear();

  let drew = draw(container, summary ?? [], SUMMARY_BUILDERS, theme);
  if (!options.isPartial && options.expanded) {
    drew = draw(container, body ?? [], FRAME_BUILDERS, theme) || drew;
  }

  if (drew) {
    container.invalidate();
  }
  return container;
}

function draw(
  container: Container,
  blocks: readonly ViewBlock[],
  builders: FrameBuilders,
  theme: Theme
): boolean {
  let drew = false;
  for (const group of AnsiPainter.paintBody(blocks, theme)) {
    for (const child of builders[group.frame](group, theme)) {
      container.addChild(child);
      drew = true;
    }
  }
  return drew;
}

function gutter(prefix: PrefixSpec, lineColor?: ThemeColor): FrameBuilder {
  return (group, theme) => {
    if (group.frame === "embed") {
      return [
        Renderer.makeMarkdownBlock({
          text: group.markdown,
          theme,
          prefix,
          lineColor,
        }),
      ];
    }
    const lines = group.lines;
    return lines.length === 0 || (lines.length === 1 && lines[0] === "")
      ? []
      : [Renderer.makePrefixedBlock({ lines, theme, prefix, lineColor })];
  };
}

function blankLine(): Component {
  return { render: () => [""], invalidate() {} };
}

function headings(group: PaintedGroup, theme: Theme): Component[] {
  const lines =
    group.frame === "embed" ? group.markdown.split("\n") : group.lines;
  return lines.map((line) =>
    line === "" ? blankLine() : Renderer.makeTitleBlock({ text: line, theme })
  );
}

const FRAME_BUILDERS: FrameBuilders = {
  flow: gutter(Renderer.GAPPED_PREFIX, "toolOutput"),
  embed: gutter(Renderer.GAPPED_PREFIX),
  tight: gutter(Renderer.TIGHT_PREFIX),
  heading: headings,
};

const SUMMARY_BUILDERS: FrameBuilders = {
  ...FRAME_BUILDERS,
  flow: gutter(Renderer.GAPPED_PREFIX),
};

/** Turns painted body lines into the pi-tui components that frame them. */
export const BodyRenderer = { render };
