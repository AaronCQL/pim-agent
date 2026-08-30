import type {
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { type PrefixSpec, type RenderContext, Renderer } from "../Renderer";
import { AnsiPainter, type BlockFrame, type PaintedGroup } from "./AnsiPainter";
import type { ViewBlock } from "./ViewBlock";

type FrameBuilder = (group: PaintedGroup, theme: Theme) => Component[];

type FrameBuilders = Record<BlockFrame, FrameBuilder>;

/**
 * Turns painted body lines into the pi-tui components that frame them. The
 * frame is the only part of a body the painter cannot decide on its own: the
 * gutter has to wrap at the terminal width, which is known at render time.
 */
export class BodyRenderer {
  public static render(args: {
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

    // The summary is the row's status line, so it survives streaming and stays
    // put while the body is collapsed away.
    let drew = draw(container, summary ?? [], SUMMARY_BUILDERS, theme);
    if (!options.isPartial && options.expanded) {
      drew = draw(container, body ?? [], FRAME_BUILDERS, theme) || drew;
    }

    if (drew) {
      container.invalidate();
    }
    return container;
  }
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
    if ("markdown" in group) {
      return [
        Renderer.makeMarkdownBlock({
          text: group.markdown,
          theme,
          prefix,
          lineColor,
        }),
      ];
    }
    const text = group.lines.join("\n");
    return text === ""
      ? []
      : [Renderer.makePrefixedBlock({ text, theme, prefix, lineColor })];
  };
}

function blankLine(): Component {
  return { render: () => [""], invalidate() {} };
}

function headings(group: PaintedGroup, theme: Theme): Component[] {
  const lines = "markdown" in group ? group.markdown.split("\n") : group.lines;
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

/**
 * A summary line is the tool's own status, not its output, so the gutter does
 * not tint it: its spans arrive already toned, the way a wrapped title keeps
 * its colours as it continues into the gutter.
 */
const SUMMARY_BUILDERS: FrameBuilders = {
  ...FRAME_BUILDERS,
  flow: gutter(Renderer.GAPPED_PREFIX),
};
