import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Images } from "../../shared/Images";
import { PimSettings } from "../../shared/PimSettings";
import { SpillCache } from "../../shared/SpillCache";
import { Tools } from "../../shared/Tools";
import { executeFetch, validatePublicUrl } from "./fetch";
import { imageContent, imageDetails, noVisionNote } from "./image";
import { JinaReaderClient } from "./JinaReaderClient";
import { webFetchView } from "./render";
import {
  type WebFetchDetails,
  type WebFetchInput,
  webFetchSchema,
} from "./schema";
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

  Tools.register<typeof webFetchSchema, WebFetchDetails>(pi, {
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch a web page as markdown or HTML. " +
      "A URL serving an image (png, jpeg, gif, webp) returns the picture itself, saved to the cache; the format parameter does not apply to it.",
    parameters: webFetchSchema,
    renderShell: "self",
    effect: { kind: "readOnly" },
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
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

      if (outcome.kind === "image") {
        const withheld = !Images.canSee(ctx.model);
        return {
          content: withheld
            ? [{ type: "text", text: noVisionNote(outcome.url, outcome.image) }]
            : imageContent(outcome.image),
          details: imageDetails(outcome.url, outcome.image, withheld),
        };
      }

      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          kind: "page",
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
