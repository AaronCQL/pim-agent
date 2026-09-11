import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type {
  WebFetchDetails,
  WebFetchFormat,
  WebFetchInput,
  WebFetchResolvedFormat,
  webFetchSchema,
} from "./schema";

type WebFetchViewInput = ToolViewInput<typeof webFetchSchema, WebFetchDetails>;

type TitleOutcome = {
  readonly format: WebFetchResolvedFormat;
  readonly totalBytes: number;
};

export function webFetchView({ args, result }: WebFetchViewInput): ToolView {
  const input = (args ?? {}) as Partial<WebFetchInput>;
  const outcome = titleOutcome(result);
  return {
    label: "Web Fetch",
    icon: "globe",
    // A `link` block would paint the URL in link colours; the title has always
    // been plain, so it stays a text block.
    title: [
      { kind: "text", text: input.url ?? "..." },
      {
        kind: "text",
        tone: "muted",
        text: formatDetail(input.format, outcome),
      },
    ],
    body: formatBody(result),
  };
}

/** The size half of the title only appears once both fields have landed. */
function titleOutcome(
  result: WebFetchViewInput["result"]
): TitleOutcome | undefined {
  const details = result?.details;
  if (details?.format === undefined || typeof details.totalBytes !== "number") {
    return undefined;
  }
  return { format: details.format, totalBytes: details.totalBytes };
}

function formatBody(result: WebFetchViewInput["result"]): readonly ViewBlock[] {
  const text = Renderer.firstText(result);
  return text === "" ? [] : [{ kind: "text", text }];
}

/** Set back from the URL by its own block rather than by parentheses. */
function formatDetail(
  format: WebFetchFormat | undefined,
  outcome: TitleOutcome | undefined
): string {
  const label = formatLabel(outcome?.format ?? format ?? "markdown");
  return outcome === undefined
    ? label
    : `${formatSize(outcome.totalBytes)} ${label}`;
}

function formatLabel(format: WebFetchResolvedFormat): string {
  return format === "html" ? "HTML" : "Markdown";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${trimZeros((bytes / 1024).toFixed(2))}KB`;
  }
  return `${trimZeros((bytes / (1024 * 1024)).toFixed(2))}MB`;
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/u, "");
}
