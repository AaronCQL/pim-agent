import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type RenderContext = {
  readonly lastComponent: Component | undefined;
  readonly isPartial: boolean;
  readonly isError: boolean;
};

export type MarkerStatus = "warning" | "error" | "success";

export type PrefixSpec = {
  readonly prefix: string;
  readonly width: number;
};

class ToolTitle implements Component {
  private text = "";
  private theme: Theme | undefined;

  public setText(text: string, theme: Theme): void {
    this.text = text;
    this.theme = theme;
  }

  public render(width: number): string[] {
    if (!this.text || this.text.trim() === "") {
      return [];
    }

    const theme = this.theme;
    const normalized = this.text.replace(/\t/g, "   ");
    const lines = wrapTextWithAnsi(normalized, Math.max(1, width));

    if (lines.length <= 1 || theme === undefined) {
      return lines.map((line) => ToolTitle.padLine(line, width));
    }

    const inner = Math.max(1, width - Renderer.GAPPED_PREFIX.width);
    const out = [ToolTitle.padLine(lines[0] ?? "", width)];

    for (const logical of lines.slice(1)) {
      for (const wrapped of wrapTextWithAnsi(logical, inner)) {
        out.push(
          ToolTitle.padLine(
            theme.fg("toolOutput", Renderer.GAPPED_PREFIX.prefix) + wrapped,
            width
          )
        );
      }
    }

    return out;
  }

  public invalidate(): void {}

  private static padLine(line: string, width: number): string {
    return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  }
}

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

  public static extractErrorText(
    result: {
      readonly content?: ReadonlyArray<{
        readonly type: string;
        readonly text?: string;
      }>;
    },
    fallback: string
  ): string {
    const text = (result.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();

    return text || fallback;
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
    readonly labelColor?: ThemeColor;
  }): Component {
    const { label, title, theme, context, labelColor } = args;
    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    const component =
      context.lastComponent instanceof ToolTitle
        ? context.lastComponent
        : new ToolTitle();
    component.setText(
      theme.fg(markerColor, " ▪") +
        " " +
        theme.fg(labelColor ?? "toolTitle", theme.bold(label)) +
        theme.fg("toolTitle", ": " + title),
      theme
    );
    return component;
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
