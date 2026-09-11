import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Format } from "../../shared/Format";
import type { HttpFetch } from "../../shared/Http";
import { Images, type NormalisedImage } from "../../shared/Images";
import type { WebFetchImageDetails } from "./schema";

export type WebFetchImageOutcome = {
  readonly kind: "image";
  readonly url: string;
  readonly image: NormalisedImage;
};

export type ImageFetchInput = {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly fetch?: HttpFetch;
};

const TIMEOUT_MS = 20_000;

const IMAGE_CONTENT_TYPE = /^image\//iu;

/** The picture the URL really serves, or null for anything the page path should handle. */
export async function fetchImage(
  input: ImageFetchInput
): Promise<NormalisedImage | null> {
  const response = await declaredImage(input);

  if (response === null) {
    return null;
  }

  const bytes = await readCapped(response, input.url);
  return bytes === null ? null : Images.normalise(bytes, input.url);
}

export function imageContent(
  image: NormalisedImage
): AgentToolResult<unknown>["content"] {
  const footer =
    image.cachePath === null
      ? []
      : [
          {
            type: "text" as const,
            text: `[web_fetch tool: image saved to ${image.cachePath}]`,
          },
        ];
  return [...Images.contentOf(image, Images.noteOf(image)), ...footer];
}

/** The fetch succeeded and the intent was ambiguous, so the model is told what it got, not refused. */
export function noVisionNote(url: string, image: NormalisedImage): string {
  const saved = image.cachePath === null ? "" : `, saved to ${image.cachePath}`;
  return Images.noVisionNote(
    "web_fetch",
    `${url} is a ${image.width}x${image.height} ${Images.extensionOf(image.mimeType)}${saved}`
  );
}

export function imageDetails(
  url: string,
  image: NormalisedImage,
  withheld: boolean
): WebFetchImageDetails {
  return {
    kind: "image",
    url,
    ...Images.detailsOf(image),
    path: image.cachePath,
    withheld,
  };
}

/** A response whose own headers claim a picture; the bytes still have to agree. */
async function declaredImage(input: ImageFetchInput): Promise<Response | null> {
  let response: Response;

  try {
    response = await (input.fetch ?? fetch)(input.url, {
      headers: { Accept: "image/*,*/*;q=0.8" },
      signal: deadline(input.signal),
    });
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok || !IMAGE_CONTENT_TYPE.test(contentType)) {
    await discard(response);
    return null;
  }

  if (
    Number(response.headers.get("content-length")) > Images.MAX_SOURCE_BYTES
  ) {
    await discard(response);
    throw oversize(input.url);
  }

  return response;
}

/** Stops at the cap and at the first chunk that is not a picture, so neither is ever buffered whole. */
async function readCapped(
  response: Response,
  url: string
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();

  if (reader === undefined) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let sniffed = false;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    total += value.byteLength;

    if (total > Images.MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw oversize(url);
    }

    if (!sniffed && total >= Images.SNIFF_BYTES) {
      if (Images.sniff(Buffer.concat(chunks)) === null) {
        await reader.cancel();
        return null;
      }
      sniffed = true;
    }
  }

  return sniffed ? Buffer.concat(chunks) : null;
}

function oversize(url: string): Error {
  return new Error(
    `Image at ${url} is over the ${Format.bytes(Images.MAX_SOURCE_BYTES)} fetch cap. Download and shrink it with bash: curl -sL ${url} -o /tmp/image && magick /tmp/image -resize 2000x2000 /tmp/small.png`
  );
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}
