import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  DefaultTextStyle,
  MarkdownTheme,
} from "@earendil-works/pi-tui";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { type PrefixSpec, Renderer } from "../../shared/Renderer";
import type { SubagentDetails, SubagentSnapshot } from "./subagent";

const DOT = "⬝";

type RenderContext = {
  readonly lastComponent: Component | undefined;
  readonly isPartial: boolean;
  readonly isError: boolean;
};

type StatusFields = Pick<
  SubagentSnapshot,
  | "usage"
  | "toolCalls"
  | "activeToolNames"
  | "lastToolName"
  | "stopReason"
  | "model"
  | "contextWindow"
>;

type MarkdownBlockArgs = {
  readonly text: string;
  readonly theme: Theme;
  readonly prefix: PrefixSpec;
  readonly lineColor?: ThemeColor;
};

class MarkdownTitle implements Component {
  private label = "";
  private title = "";
  private theme: Theme | undefined;
  private context: RenderContext | undefined;
  private labelColor: ThemeColor | undefined;

  public set(args: {
    readonly label: string;
    readonly title: string;
    readonly theme: Theme;
    readonly context: RenderContext;
    readonly labelColor?: ThemeColor;
  }): void {
    this.label = args.label;
    this.title = args.title;
    this.theme = args.theme;
    this.context = args.context;
    this.labelColor = args.labelColor;
  }

  public render(width: number): string[] {
    const theme = this.theme;
    const context = this.context;
    if (!theme || !context) {
      return [];
    }

    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    const prefix =
      theme.fg(markerColor, " ▪") +
      " " +
      theme.fg(this.labelColor ?? "toolTitle", theme.bold(this.label)) +
      theme.fg("toolTitle", ": ");
    const inner = Math.max(1, width - visibleWidth(prefix));
    const titleLines = renderMarkdownLines({
      text: this.title,
      theme,
      width: inner,
    });
    const lines = titleLines.length > 0 ? titleLines : [""];
    const out = [padLine(prefix + (lines[0] ?? ""), width)];

    for (const line of lines.slice(1)) {
      out.push(
        padLine(
          theme.fg("toolOutput", Renderer.GAPPED_PREFIX.prefix) + line,
          width
        )
      );
    }

    return out;
  }

  public invalidate(): void {}
}

export function formatCallTitle(prompt: string | undefined): string {
  return (prompt ?? "...").split(/\r?\n/u)[0]?.trim() || "...";
}

export function formatTopLine(snapshot: StatusFields): string {
  return [
    formatCost(snapshot.usage.cost),
    formatContext(snapshot),
    snapshot.model ?? "unknown model",
    formatActivity(snapshot),
  ].join(` ${DOT} `);
}

export function renderCall(
  args: { readonly prompt?: string } | undefined,
  theme: Theme,
  context: RenderContext
): Component {
  const component =
    context.lastComponent instanceof MarkdownTitle
      ? context.lastComponent
      : new MarkdownTitle();
  component.set({
    label: "Subagent",
    title: formatCallTitle(args?.prompt),
    theme,
    context,
    labelColor: titleColorFor(context),
  });
  return component;
}

export function renderResult(
  result: AgentToolResult<SubagentDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext
): Component {
  const container =
    context.lastComponent instanceof Container
      ? context.lastComponent
      : new Container();
  container.clear();

  const details = result.details;
  const first = result.content?.[0];
  const body = first && "text" in first ? (first.text ?? "") : "";
  const topLine = details?.topLine;

  if (topLine) {
    container.addChild(
      Renderer.makePrefixedBlock({
        text: styleDottedLine({
          text: topLine,
          theme,
          lineColor: options.isPartial ? "warning" : "accent",
        }),
        theme,
        prefix: Renderer.GAPPED_PREFIX,
      })
    );
  }

  if (!options.isPartial && (!topLine || options.expanded) && body) {
    container.addChild(
      options.expanded
        ? makePrefixedMarkdownBlock({
            text: body,
            theme,
            prefix: Renderer.GAPPED_PREFIX,
            lineColor: expandedResultColor(details, context.isError),
          })
        : Renderer.makePrefixedBlock({
            text: body,
            theme,
            prefix: Renderer.GAPPED_PREFIX,
            lineColor: resultColor(details, context.isError),
          })
    );
  }

  container.invalidate();
  return container;
}

function makePrefixedMarkdownBlock(args: MarkdownBlockArgs): Component {
  const markdown = new Markdown(
    args.text,
    0,
    0,
    makeMarkdownTheme(args.theme),
    defaultStyle(args.theme, args.lineColor)
  );

  return {
    render(width: number): string[] {
      const inner = Math.max(1, width - args.prefix.width);
      return markdown.render(inner).map((line) => {
        return (
          args.theme.fg("toolOutput", args.prefix.prefix) +
          trimRenderedLine(line)
        );
      });
    },
    invalidate(): void {
      markdown.invalidate();
    },
  };
}

function renderMarkdownLines(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly width: number;
  readonly lineColor?: ThemeColor;
}): string[] {
  const markdown = new Markdown(
    args.text,
    0,
    0,
    makeMarkdownTheme(args.theme),
    defaultStyle(args.theme, args.lineColor)
  );
  return markdown.render(args.width).map(trimRenderedLine);
}

function defaultStyle(
  theme: Theme,
  lineColor: ThemeColor | undefined
): DefaultTextStyle | undefined {
  return lineColor
    ? { color: (text: string) => theme.fg(lineColor, text) }
    : undefined;
}

function makeMarkdownTheme(theme: Theme): MarkdownTheme {
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

function trimRenderedLine(line: string): string {
  return line.trimEnd();
}

function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function styleDottedLine(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly lineColor: ThemeColor;
}): string {
  return args.text
    .split(DOT)
    .map((part) => args.theme.fg(args.lineColor, part))
    .join(args.theme.fg("muted", DOT));
}

function titleColorFor(context: RenderContext): ThemeColor {
  if (context.isPartial) {
    return "warning";
  }
  if (context.isError) {
    return "error";
  }
  return "accent";
}

function resultColor(
  details: SubagentDetails | undefined,
  isError: boolean
): "toolOutput" | "error" | "warning" {
  if (details?.stopReason === "aborted") {
    return "warning";
  }
  return isError ? "error" : "toolOutput";
}

function expandedResultColor(
  details: SubagentDetails | undefined,
  isError: boolean
): "error" | "warning" | undefined {
  if (details?.stopReason === "aborted") {
    return "warning";
  }
  return isError ? "error" : undefined;
}

function formatActivity(snapshot: StatusFields): string {
  const turns = `${snapshot.usage.turns} ${snapshot.usage.turns === 1 ? "turn" : "turns"}`;
  if (snapshot.stopReason !== undefined) {
    const toolCount = snapshot.toolCalls.length;
    return toolCount > 0
      ? `${turns} ${DOT} ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`
      : turns;
  }

  return `${turns} ${DOT} ${activeToolLabel(snapshot)}`;
}

function activeToolLabel(snapshot: StatusFields): string {
  if (snapshot.activeToolNames.length === 1) {
    return snapshot.activeToolNames[0]!;
  }
  if (snapshot.activeToolNames.length > 1) {
    return `${snapshot.activeToolNames.length} tools`;
  }
  return snapshot.lastToolName ?? "thinking";
}

function formatContext(snapshot: StatusFields): string {
  const window = snapshot.contextWindow;
  if (!window || window <= 0) {
    return "?/?";
  }
  const windowText = formatTokens(window);
  const tokens = snapshot.usage.contextTokens;
  if (tokens === undefined) {
    return `?/${windowText}`;
  }
  return `${((tokens / window) * 100).toFixed(1)}%/${windowText}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  if (tokens < 10_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
