import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import { Tools } from "../../shared/Tools";
import { DuckDuckGoProvider } from "./providers/DuckDuckGoProvider";
import { ExaProvider } from "./providers/ExaProvider";
import { FirecrawlProvider } from "./providers/FirecrawlProvider";
import { webSearchView } from "./render";
import { SearchBreaker } from "./SearchBreaker";
import { SearchChain } from "./SearchChain";
import { type WebSearchInput, webSearchSchema } from "./schema";
import { clampNumResults, formatResults } from "./search";

const ERROR_PREVIEW_LINES = 6;

async function createChain(): Promise<SearchChain> {
  const [exaApiKey, firecrawlApiKey, jinaApiKey] = await Promise.all([
    PimSettings.getExaApiKey(),
    PimSettings.getFirecrawlApiKey(),
    PimSettings.getJinaApiKey(),
  ]);

  return new SearchChain({
    breaker: new SearchBreaker(),
    providers: [
      new ExaProvider(exaApiKey === undefined ? {} : { apiKey: exaApiKey }),
      new FirecrawlProvider(
        firecrawlApiKey === undefined ? {} : { apiKey: firecrawlApiKey }
      ),
      new DuckDuckGoProvider(
        jinaApiKey === undefined ? {} : { apiKey: jinaApiKey }
      ),
    ],
  });
}

export default function (pi: ExtensionAPI): void {
  let chainPromise: Promise<SearchChain> | undefined;
  const getChain = () => (chainPromise ??= createChain());

  Tools.register(pi, {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. " +
      "Returns ranked results with title, URL, and a short snippet.",
    parameters: webSearchSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal) {
      const { query, numResults } = params as WebSearchInput;

      if (signal?.aborted) {
        throw new Error("Web search aborted before execution.");
      }

      const trimmed = query.trim();
      if (trimmed.length === 0) {
        throw new Error(
          "Web search query is empty. Provide a non-empty query."
        );
      }

      const clamped = clampNumResults(numResults);
      const chain = await getChain();
      const outcome = await chain.search({
        query: trimmed,
        numResults: clamped,
        ...(signal === undefined ? {} : { signal }),
      });

      if (outcome.results.length === 0) {
        throw new Error(
          `No web results for "${trimmed}" (via ${outcome.provider}). ` +
            "Try broader keywords or different phrasing."
        );
      }

      return {
        content: [{ type: "text", text: formatResults(outcome.results) }],
        details: {
          query: trimmed,
          numResults: clamped,
          count: outcome.results.length,
          provider: outcome.provider,
          fellBack: outcome.fellBack,
        },
      };
    },
    toViewModel: webSearchView,
    previewLines: ERROR_PREVIEW_LINES,
  });
}
