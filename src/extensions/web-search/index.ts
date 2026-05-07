import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Renderer } from "../../shared/Renderer";
import { ExaMcpClient } from "./ExaMcpClient";
import { formatTitle } from "./render";
import { type WebSearchInput, webSearchSchema } from "./schema";
import { clampNumResults, formatResults } from "./search";

const PREVIEW_LINES = 6;

export default function (pi: ExtensionAPI): void {
  const apiKey = process.env["EXA_API_KEY"];
  const client = new ExaMcpClient(apiKey ? { apiKey } : {});

  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the public web. Returns ranked results with title, URL, and a short snippet.",
    promptSnippet: "Search the web.",
    parameters: webSearchSchema,
    renderShell: "self",
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
      const input = (args ?? {}) as Partial<WebSearchInput>;
      return Renderer.renderToolCallTitle({
        label: "Web Search",
        title: formatTitle(input.query, input.numResults),
        theme,
        context,
      });
    },
    renderResult(result, options, theme, context) {
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
