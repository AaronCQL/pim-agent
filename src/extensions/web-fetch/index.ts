import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import {
  clampMaxBytes,
  executeFetch,
  validatePublicUrl,
  type WebFetchOutcome,
} from "./fetch";
import { JinaReaderClient } from "./JinaReaderClient";
import { formatTitle, type WebFetchTitleOutcome } from "./render";
import { type WebFetchInput, webFetchSchema } from "./schema";
import { WebViewFetchClient } from "./WebViewFetchClient";

const PREVIEW_LINES = 10;

type WebFetchRenderState = {
  outcome?: WebFetchTitleOutcome;
};

export default function (pi: ExtensionAPI): void {
  const apiKey = process.env["JINA_API_KEY"];
  const jina = new JinaReaderClient(apiKey ? { apiKey } : {});
  const webView = new WebViewFetchClient();

  Tools.register(pi, {
    name: "web_fetch",
    label: "web_fetch",
    description: "Fetch a URL and return its markdown or HTML content.",
    parameters: webFetchSchema,
    renderShell: "self",
    async execute(_id, params, signal) {
      const { url, maxBytes, format } = params as WebFetchInput;

      if (signal?.aborted) {
        throw new Error("Web fetch aborted before execution.");
      }

      const safeUrl = validatePublicUrl(url);
      const clampedMaxBytes = clampMaxBytes(maxBytes);

      const outcome = await executeFetch({
        jina,
        webView,
        url: safeUrl,
        maxBytes: clampedMaxBytes,
        format: format ?? "auto",
        ...(signal === undefined ? {} : { signal }),
      });

      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          url: outcome.url,
          title: outcome.title,
          format: outcome.format,
          returnedBytes: outcome.returnedBytes,
          totalBytes: outcome.totalBytes,
          truncated: outcome.truncated,
          maxBytes: outcome.maxBytes,
        },
      };
    },
    renderCall(args, theme, context) {
      const input = (args ?? {}) as Partial<WebFetchInput>;
      const state = context.state as WebFetchRenderState;
      return Renderer.renderToolCallTitle({
        label: "Web Fetch",
        title: formatTitle(input.url, state.outcome),
        theme,
        context,
      });
    },
    renderResult(result, options, theme, context) {
      const state = context.state as WebFetchRenderState;

      if (!options.isPartial && state.outcome === undefined) {
        const details = result.details as
          | Pick<WebFetchOutcome, "format" | "totalBytes">
          | undefined;

        if (
          details?.format !== undefined &&
          typeof details.totalBytes === "number"
        ) {
          state.outcome = {
            format: details.format,
            totalBytes: details.totalBytes,
          };
          context.invalidate();
        }
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
