import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import {
  type Component,
  Container,
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type RenderContext = {
  readonly lastComponent: Component | undefined;
  readonly isPartial: boolean;
  readonly isError: boolean;
};

export type StatefulToolCallTitleContext = RenderContext & {
  readonly state: unknown;
};

export type StatefulToolCallTitleState = {
  titleComponent?: Component;
};

export type MarkerStatus = "warning" | "error" | "success";

export type PrefixSpec = {
  readonly prefix: string;
  readonly width: number;
};

const GAPPED_PREFIX: PrefixSpec = {
  prefix: " │ ",
  width: 3,
};
const TIGHT_PREFIX: PrefixSpec = {
  prefix: " │",
  width: 2,
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
      return lines.map((line) => padLine(line, width));
    }

    const inner = Math.max(1, width - GAPPED_PREFIX.width);
    const out = [padLine(lines[0] ?? "", width)];

    for (const logical of lines.slice(1)) {
      for (const wrapped of wrapTextWithAnsi(logical, inner)) {
        out.push(
          padLine(theme.fg("toolOutput", GAPPED_PREFIX.prefix) + wrapped, width)
        );
      }
    }

    return out;
  }

  public invalidate(): void {}
}

/**
 * A title whose text is markdown. It cannot reuse `ToolTitle`: markdown wraps
 * itself, so the wrap width is the room left after the marker and label rather
 * than the full width, and the rendered text carries its own colours.
 */
class MarkdownTitle implements Component {
  private prefix = "";
  private title = "";
  private theme: Theme | undefined;

  public set(args: {
    readonly prefix: string;
    readonly title: string;
    readonly theme: Theme;
  }): void {
    this.prefix = args.prefix;
    this.title = args.title;
    this.theme = args.theme;
  }

  public render(width: number): string[] {
    const theme = this.theme;
    if (!theme) {
      return [];
    }

    const inner = Math.max(1, width - visibleWidth(this.prefix));
    const titleLines = markdownLines({
      text: this.title,
      theme,
      width: inner,
    });
    const lines = titleLines.length > 0 ? titleLines : [""];
    const out = [padLine(this.prefix + (lines[0] ?? ""), width)];

    for (const line of lines.slice(1)) {
      out.push(
        padLine(theme.fg("toolOutput", GAPPED_PREFIX.prefix) + line, width)
      );
    }

    return out;
  }

  public invalidate(): void {}
}

function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function makeMarkdown(
  text: string,
  theme: Theme,
  lineColor: ThemeColor | undefined
): Markdown {
  return new Markdown(
    text,
    0,
    0,
    markdownTheme(theme),
    lineColor ? { color: (t: string) => theme.fg(lineColor, t) } : undefined
  );
}

function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => theme.strikethrough(text),
  };
}

function markerColorFor(isPartial: boolean, isError: boolean): MarkerStatus {
  if (isPartial) {
    return "warning";
  }
  if (isError) {
    return "error";
  }
  return "success";
}

/**
 * The text of a result's first content item, or "" when the result, its
 * content, or the text is missing — the body every text-shaped tool renders.
 */
function firstText(
  result:
    | {
        readonly content?: ReadonlyArray<{
          readonly type: string;
          readonly text?: string;
        }>;
      }
    | undefined
): string {
  const first = result?.content?.[0];
  return first && "text" in first ? (first.text ?? "") : "";
}

function extractErrorText(
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

/** The marker + bold label + title text of a tool row, without the shell. */
function toolTitleText(args: {
  readonly label: string;
  readonly title: string;
  readonly theme: Theme;
  readonly markerColor: MarkerStatus;
  readonly labelColor?: ThemeColor;
}): string {
  return titleHead(args) + args.theme.fg("toolTitle", ": " + args.title);
}

function titleHead(args: {
  readonly label: string;
  readonly theme: Theme;
  readonly markerColor: MarkerStatus;
  readonly labelColor?: ThemeColor;
}): string {
  const { label, theme, markerColor, labelColor } = args;
  return (
    theme.fg(markerColor, " ▪") +
    " " +
    theme.fg(labelColor ?? "toolTitle", theme.bold(label))
  );
}

/** Wraps title text in the component that pads and re-indents on overflow. */
function makeTitleBlock(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly lastComponent?: Component;
}): Component {
  const component =
    args.lastComponent instanceof ToolTitle
      ? args.lastComponent
      : new ToolTitle();
  component.setText(args.text, args.theme);
  return component;
}

function renderToolCallTitle(args: {
  readonly label: string;
  readonly title: string;
  readonly theme: Theme;
  readonly context: RenderContext;
  readonly labelColor?: ThemeColor;
  /** Renders `title` as markdown instead of as pre-painted text. */
  readonly markdown?: boolean;
}): Component {
  const { theme, context } = args;
  const markerColor = markerColorFor(
    Boolean(context.isPartial),
    Boolean(context.isError)
  );

  if (args.markdown === true) {
    const component =
      context.lastComponent instanceof MarkdownTitle
        ? context.lastComponent
        : new MarkdownTitle();
    component.set({
      prefix: titleHead({ ...args, markerColor }) + theme.fg("toolTitle", ": "),
      title: args.title,
      theme,
    });
    return component;
  }

  return makeTitleBlock({
    text: toolTitleText({ ...args, markerColor }),
    theme,
    lastComponent: context.lastComponent,
  });
}

function renderStatefulToolCallTitle(args: {
  readonly label: string;
  readonly title: string;
  readonly theme: Theme;
  readonly context: StatefulToolCallTitleContext;
  readonly labelColor?: ThemeColor;
}): Component {
  const state = args.context.state as StatefulToolCallTitleState;
  const component = renderToolCallTitle({
    ...args,
    context: {
      ...args.context,
      lastComponent: state.titleComponent ?? args.context.lastComponent,
    },
  });
  state.titleComponent = component;
  return component;
}

function makePrefixedBlock(args: {
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

/** Markdown lines at a fixed width, trimmed the way the tool rows expect. */
function markdownLines(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly width: number;
  readonly lineColor?: ThemeColor;
}): string[] {
  return makeMarkdown(args.text, args.theme, args.lineColor)
    .render(args.width)
    .map((line) => line.trimEnd());
}

/** A gutter block whose text is markdown, wrapped at the render-time width. */
function makeMarkdownBlock(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly prefix: PrefixSpec;
  readonly lineColor?: ThemeColor;
}): Component {
  const { text, theme, prefix, lineColor } = args;
  const markdown = makeMarkdown(text, theme, lineColor);

  return {
    render(width: number): string[] {
      const inner = Math.max(1, width - prefix.width);
      return markdown
        .render(inner)
        .map((line) => theme.fg("toolOutput", prefix.prefix) + line.trimEnd());
    },
    invalidate(): void {
      markdown.invalidate();
    },
  };
}

/**
 * The gutter body of a failed call. Like every other row it stays shut until
 * the row is expanded, and once opened it shows the failure whole: an error is
 * read to be acted on, and a stack trace cut off at its tenth line is the part
 * that says least.
 */
function renderErrorResult(args: {
  readonly result: AgentToolResult<unknown>;
  readonly options: ToolRenderResultOptions;
  readonly theme: Theme;
  readonly context: RenderContext;
}): Container {
  const { result, options, theme, context } = args;
  const container =
    (context.lastComponent as Container | undefined) ?? new Container();
  container.clear();

  if (options.isPartial || !options.expanded) {
    return container;
  }

  const body = firstText(result);
  if (!body) {
    return container;
  }

  container.addChild(
    makePrefixedBlock({
      text: body,
      theme,
      prefix: GAPPED_PREFIX,
      lineColor: "error",
    })
  );

  container.invalidate();
  return container;
}

export const Renderer = {
  GAPPED_PREFIX,
  TIGHT_PREFIX,
  markerColorFor,
  firstText,
  extractErrorText,
  toolTitleText,
  makeTitleBlock,
  renderToolCallTitle,
  renderStatefulToolCallTitle,
  makePrefixedBlock,
  markdownLines,
  makeMarkdownBlock,
  renderErrorResult,
};
