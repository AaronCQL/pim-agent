import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Renderer,
  type StatefulToolCallTitleContext,
  type StatefulToolCallTitleState,
} from "../../shared/Renderer";
import { PimSettings } from "../../shared/PimSettings";
import { Tools } from "../../shared/Tools";
import { ExaMcpClient } from "./ExaMcpClient";
import { formatTitle } from "./render";
import { type WebSearchInput, webSearchSchema } from "./schema";
import { clampNumResults, formatResults } from "./search";

const PREVIEW_LINES = 6;

type WebSearchCallState = StatefulToolCallTitleState & {
  resultCount?: number;
};

type WebSearchRenderContext = StatefulToolCallTitleContext & {
  readonly args?: WebSearchInput;
};

async function createClient(): Promise<ExaMcpClient> {
  const apiKey = await PimSettings.getExaApiKey();
  return new ExaMcpClient(apiKey ? { apiKey } : {});
}

function renderTitle(
  input: Partial<WebSearchInput>,
  theme: Theme,
  context: WebSearchRenderContext
) {
  const state = context.state as WebSearchCallState;
  const count = state.resultCount ?? clampNumResults(input.numResults);
  return Renderer.renderStatefulToolCallTitle({
    label: "Web Search",
    title: formatTitle(input.query, count),
    theme,
    context,
  });
}

export default function (pi: ExtensionAPI): void {
  let clientPromise: Promise<ExaMcpClient> | undefined;
  const getClient = () => (clientPromise ??= createClient());

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
      const client = await getClient();
      const results = await client.search({
        query: trimmed,
        numResults: clamped,
        ...(signal === undefined ? {} : { signal }),
      });

      if (results.length === 0) {
        throw new Error(
          `No web results for "${trimmed}". Try broader keywords or different phrasing.`
        );
      }

      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: {
          query: trimmed,
          numResults: clamped,
          count: results.length,
        },
      };
    },
    renderCall(args, theme, context) {
      return renderTitle(
        (args ?? {}) as Partial<WebSearchInput>,
        theme,
        context
      );
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WebSearchCallState;
      const details = result.details as { readonly count?: number } | undefined;

      if (details?.count !== undefined) {
        state.resultCount = details.count;
        renderTitle(context.args ?? {}, theme, context);
      }

      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
