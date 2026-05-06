import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  Text,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

type RenderContext = {
  readonly lastComponent: Component | undefined;
  readonly isPartial: boolean;
  readonly isError: boolean;
};

export type MarkerStatus = "warning" | "error" | "success";

type PrefixSpec = {
  readonly prefix: string;
  readonly width: number;
};

export class Renderer {
  public static readonly GAPPED_PREFIX: PrefixSpec = {
    prefix: " │ ",
    width: 3,
  };
  public static readonly TIGHT_PREFIX: PrefixSpec = {
    prefix: " │",
    width: 2,
  };

  public static markerColorFor(
    isPartial: boolean,
    isError: boolean
  ): MarkerStatus {
    if (isPartial) {
      return "warning";
    }
    if (isError) {
      return "error";
    }
    return "success";
  }

  public static buildPreviewLines(
    body: string,
    maxLines: number
  ): { preview: string; overflow: number } {
    const lines = body.split("\n");
    if (lines.length <= maxLines) {
      return { preview: body, overflow: 0 };
    }
    return {
      preview: lines.slice(0, maxLines).join("\n"),
      overflow: lines.length - maxLines,
    };
  }

  public static renderToolCallTitle(args: {
    readonly label: string;
    readonly title: string;
    readonly theme: Theme;
    readonly context: RenderContext;
  }): Text {
    const { label, title, theme, context } = args;
    const text =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    text.setText(
      theme.fg(markerColor, " ▪") +
        " " +
        theme.fg("toolTitle", theme.bold(label) + ": " + title)
    );
    return text;
  }

  public static makePrefixedBlock(args: {
    readonly text: string;
    readonly theme: Theme;
    readonly prefix: PrefixSpec;
    readonly lineColor?: ThemeColor;
  }): Component {
    const { text, theme, prefix, lineColor } = args;
    return {
      render(width: number): string[] {
        const inner = Math.max(1, width - prefix.width);
        const out: string[] = [];
        for (const logical of text.split("\n")) {
          for (const w of wrapTextWithAnsi(logical, inner)) {
            const body = lineColor ? theme.fg(lineColor, w) : w;
            out.push(theme.fg("toolOutput", prefix.prefix) + body);
          }
        }
        return out;
      },
      invalidate() {},
    };
  }

  public static renderBorderedResult(args: {
    readonly result: AgentToolResult<unknown>;
    readonly options: ToolRenderResultOptions;
    readonly theme: Theme;
    readonly context: RenderContext;
    readonly previewLines: number;
  }): Container {
    const { result, options, theme, context, previewLines } = args;
    const container =
      (context.lastComponent as Container | undefined) ?? new Container();
    container.clear();

    if (options.isPartial) {
      return container;
    }
    if (!context.isError && !options.expanded) {
      return container;
    }

    const first = result.content?.[0];
    const body = first && "text" in first ? (first.text ?? "") : "";
    if (!body) {
      return container;
    }

    const lineColor = context.isError ? "error" : "toolOutput";
    const block = (text: string): Component =>
      Renderer.makePrefixedBlock({
        text,
        theme,
        prefix: Renderer.GAPPED_PREFIX,
        lineColor,
      });

    if (options.expanded) {
      container.addChild(block(body));
    } else {
      const { preview, overflow } = Renderer.buildPreviewLines(
        body,
        previewLines
      );
      if (preview) {
        container.addChild(block(preview));
      }
      if (overflow > 0) {
        container.addChild(block(`… ${overflow} more lines`));
      }
    }

    container.invalidate();
    return container;
  }
}
