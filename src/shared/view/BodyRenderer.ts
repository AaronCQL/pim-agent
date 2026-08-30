import type {
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { type PrefixSpec, type RenderContext, Renderer } from "../Renderer";
import { AnsiPainter, type BlockFrame } from "./AnsiPainter";
import type { ViewBlock } from "./ViewBlock";

type FrameBuilder = (lines: readonly string[], theme: Theme) => Component[];

/**
 * Turns painted body lines into the pi-tui components that frame them. The
 * frame is the only part of a body the painter cannot decide on its own: the
 * gutter has to wrap at the terminal width, which is known at render time.
 */
export class BodyRenderer {
  public static render(args: {
    readonly blocks: readonly ViewBlock[];
    readonly options: ToolRenderResultOptions;
    readonly theme: Theme;
    readonly context: RenderContext;
  }): Container {
    const { blocks, options, theme, context } = args;
    const container =
      (context.lastComponent as Container | undefined) ?? new Container();
    container.clear();

    if (options.isPartial || !options.expanded) {
      return container;
    }

    let drew = false;
    for (const group of AnsiPainter.paintBody(blocks, theme)) {
      for (const child of FRAME_BUILDERS[group.frame](group.lines, theme)) {
        container.addChild(child);
        drew = true;
      }
    }

    if (drew) {
      container.invalidate();
    }
    return container;
  }
}

function gutter(prefix: PrefixSpec, lineColor?: ThemeColor): FrameBuilder {
  return (lines, theme) => {
    const text = lines.join("\n");
    return text === ""
      ? []
      : [Renderer.makePrefixedBlock({ text, theme, prefix, lineColor })];
  };
}

function blankLine(): Component {
  return { render: () => [""], invalidate() {} };
}

const FRAME_BUILDERS = {
  flow: gutter(Renderer.GAPPED_PREFIX, "toolOutput"),
  embed: gutter(Renderer.TIGHT_PREFIX),
  heading: (lines, theme) =>
    lines.map((line) =>
      line === "" ? blankLine() : Renderer.makeTitleBlock({ text: line, theme })
    ),
} as const satisfies Record<BlockFrame, FrameBuilder>;
