import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type {
  WebSearchDetails,
  WebSearchInput,
  webSearchSchema,
} from "./schema";
import { clampNumResults } from "./search";

type WebSearchViewInput = ToolViewInput<
  typeof webSearchSchema,
  WebSearchDetails
>;

export function webSearchView({ args, result }: WebSearchViewInput): ToolView {
  const input = (args ?? {}) as Partial<WebSearchInput>;
  const details = result?.details;
  return {
    label: "Web Search",
    icon: "globe",
    title: [
      {
        kind: "text",
        text: input.query ?? "...",
      },
      {
        kind: "text",
        tone: "muted",
        text: formatDetail(
          details?.count ?? clampNumResults(input.numResults),
          details?.provider
        ),
      },
    ],
    body: formatBody(result),
  };
}

function formatBody(
  result: WebSearchViewInput["result"]
): readonly ViewBlock[] {
  const text = Renderer.firstText(result);
  return text === "" ? [] : [{ kind: "text", text }];
}

function formatDetail(count: number, provider: string | undefined): string {
  return provider === undefined ? `${count}` : `${count} · ${provider}`;
}
