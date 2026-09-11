import { Format } from "../../shared/Format";
import { Images } from "../../shared/Images";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import { Painting } from "../../view/Painting";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type {
  WebFetchDetails,
  WebFetchFormat,
  WebFetchImageDetails,
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
  const image = imageDetailsOf(result?.details);
  const url = image?.url ?? input.url ?? "...";
  return {
    label: "Web Fetch",
    icon: "globe",
    title: [
      { kind: "text", text: url },
      {
        kind: "text",
        tone: "muted",
        text: image
          ? imageDetail(image)
          : formatDetail(input.format, titleOutcome(result)),
      },
    ],
    body: image ? imageBody(image, url) : formatBody(result),
  };
}

/** Legacy sessions predate the tag, so anything untagged reads as a page. */
function imageDetailsOf(
  details: WebFetchDetails | undefined
): WebFetchImageDetails | undefined {
  return details?.kind === "image" ? details : undefined;
}

function imageBody(
  details: WebFetchImageDetails,
  url: string
): readonly ViewBlock[] {
  return Painting.imageBlocks(
    details,
    url,
    details.withheld
      ? [["not sent", "the current model has no vision input"]]
      : []
  );
}

function imageDetail(details: WebFetchImageDetails): string {
  return `${Format.bytesCompact(details.bytes)} ${Images.extensionOf(details.mimeType).toUpperCase()}`;
}

function titleOutcome(
  result: WebFetchViewInput["result"]
): TitleOutcome | undefined {
  const details = result?.details;
  if (
    details === undefined ||
    details.kind === "image" ||
    details.format === undefined ||
    typeof details.totalBytes !== "number"
  ) {
    return undefined;
  }
  return { format: details.format, totalBytes: details.totalBytes };
}

function formatBody(result: WebFetchViewInput["result"]): readonly ViewBlock[] {
  const text = Renderer.firstText(result);
  return text === "" ? [] : [{ kind: "text", text }];
}

function formatDetail(
  format: WebFetchFormat | undefined,
  outcome: TitleOutcome | undefined
): string {
  const label = formatLabel(outcome?.format ?? format ?? "markdown");
  return outcome === undefined
    ? label
    : `${Format.bytesCompact(outcome.totalBytes)} ${label}`;
}

function formatLabel(format: WebFetchResolvedFormat): string {
  return format === "html" ? "HTML" : "Markdown";
}
