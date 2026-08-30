import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../shared/view/ViewBlock";
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
  return {
    label: "Web Fetch",
    // A `link` block would paint the URL in link colours; the title has always
    // been plain, so it stays a text block.
    title: [
      {
        kind: "text",
        text: formatTitle(input.url, input.format, titleOutcome(result)),
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
  const first = result?.content?.[0];
  const text = first && "text" in first ? (first.text ?? "") : "";
  return text === "" ? [] : [{ kind: "text", text }];
}

function formatTitle(
  url: string | undefined,
  format: WebFetchFormat | undefined,
  outcome: TitleOutcome | undefined
): string {
  const u = url ?? "...";
  const label = formatLabel(outcome?.format ?? format ?? "markdown");

  if (outcome !== undefined) {
    return `${u} (${formatSize(outcome.totalBytes)} ${label})`;
  }

  return `${u} (${label})`;
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
