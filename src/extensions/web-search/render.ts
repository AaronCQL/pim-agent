import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../shared/view/ViewBlock";
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
        text: formatTitle(
          input.query,
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
  const first = result?.content?.[0];
  const text = first && "text" in first ? (first.text ?? "") : "";
  return text === "" ? [] : [{ kind: "text", text }];
}

/** `fellBack` stays out of the title: the provider name already tells the story. */
function formatTitle(
  query: string | undefined,
  count: number,
  provider: string | undefined
): string {
  const q = query ?? "...";
  const suffix = provider === undefined ? "" : ` · ${provider}`;
  return `${q} (${count}${suffix})`;
}
