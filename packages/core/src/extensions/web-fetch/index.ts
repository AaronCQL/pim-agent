import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import { SpillCache } from "../../shared/SpillCache";
import { Tools } from "../../shared/Tools";
import { executeFetch, validatePublicUrl } from "./fetch";
import { JinaReaderClient } from "./JinaReaderClient";
import { webFetchView } from "./render";
import { type WebFetchInput, webFetchSchema } from "./schema";
import { WebViewFetchClient } from "./WebViewFetchClient";

async function createJina(): Promise<JinaReaderClient> {
  const apiKey = await PimSettings.getJinaApiKey();
  return new JinaReaderClient(apiKey ? { apiKey } : {});
}

export default function (pi: ExtensionAPI): void {
  SpillCache.installSweeper();

  let jinaPromise: Promise<JinaReaderClient> | undefined;
  const getJina = () => (jinaPromise ??= createJina());
  const webView = new WebViewFetchClient();

  Tools.register(pi, {
    name: "web_fetch",
    label: "web_fetch",
    description: "Fetch a web page as markdown or HTML.",
    parameters: webFetchSchema,
    renderShell: "self",
    effect: { kind: "readOnly" },
    executionMode: "parallel",
    async execute(_id, params, signal) {
      const { url, format } = params as WebFetchInput;

      if (signal?.aborted) {
        throw new Error("Web fetch aborted before execution.");
      }

      const safeUrl = validatePublicUrl(url);

      const jina = await getJina();
      const outcome = await executeFetch({
        jina,
        webView,
        url: safeUrl,
        format: format ?? "markdown",
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
          path: outcome.path,
        },
      };
    },
    toViewModel: webFetchView,
  });
}
