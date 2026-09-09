import {
  type AgentToolResult,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import { extname } from "node:path";
import { Format } from "./Format";
import { ImageMime, type ImageMimeType } from "./ImageMime";
import { Lines } from "./Lines";
import { SpillCache } from "./SpillCache";

export type { ImageMimeType };

/** What a tool needs off `ctx.model` to know whether a picture can be sent. */
export type VisionModel = {
  readonly id: string;
  readonly input: readonly string[];
};

/** An image the providers will take: within their formats, dimensions and byte budget. */
export type NormalisedImage = {
  readonly base64: string;
  readonly mimeType: ImageMimeType;
  readonly width: number;
  readonly height: number;
  /** Encoded size after the resize, which is what the cache holds. */
  readonly bytes: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  /** The container the frames were counted in: a resize is free to re-encode as another. */
  readonly originalMimeType: ImageMimeType;
  readonly resized: boolean;
  /** Frames in the source container, 1 for a still: the encoded copy holds only the first. */
  readonly frames: number;
  readonly sha256: string;
  /** `~/.pim/cache/img-<sha256>.<ext>`, or null when the cache write failed. */
  readonly cachePath: string | null;
};

/** What every tool records about a picture it showed: the picture itself never rides here, `sha256` addresses it in the spill cache. */
export type ImageDetails = {
  readonly sha256: string;
  readonly mimeType: ImageMimeType;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly resized: boolean;
  readonly frames: number;
};

type ToolContent = AgentToolResult<unknown>["content"];

/** Never decode past this: a mislabelled video is rejected on its size alone. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 2000;
const MAX_ENCODED_BYTES = 3_932_160;

/** Enough for every magic-byte signature, WebP's `RIFF….WEBP` included. */
const SNIFF_BYTES = 12;

const CACHE_PREFIX = "img-";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ANMF = [0x41, 0x4e, 0x4d, 0x46];
const ACTL = [0x61, 0x63, 0x54, 0x4c];
const IDAT = [0x49, 0x44, 0x41, 0x54];

const GIF_EXTENSION = 0x21;
const GIF_IMAGE_DESCRIPTOR = 0x2c;

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0
): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Magic bytes only: an extension is a claim, not evidence. */
function sniff(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, PNG)) {
    return "image/png";
  }
  if (startsWith(bytes, JPEG)) {
    return "image/jpeg";
  }
  if (startsWith(bytes, GIF)) {
    return "image/gif";
  }
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    return "image/webp";
  }
  return null;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** RIFF chunks are padded to an even length, so an odd body carries one trailing byte. */
function webpFrames(bytes: Uint8Array): number {
  const reader = view(bytes);
  let count = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const size = reader.getUint32(at + 4, true);
    if (startsWith(bytes, ANMF, at)) {
      count += 1;
    }
    at += 8 + size + (size % 2);
  }
  return count;
}

/** `acTL` carries the count outright, and must appear before the first `IDAT`. */
function apngFrames(bytes: Uint8Array): number {
  const reader = view(bytes);
  let at = 8;
  while (at + 12 <= bytes.byteLength) {
    if (startsWith(bytes, ACTL, at + 4)) {
      return reader.getUint32(at + 8);
    }
    if (startsWith(bytes, IDAT, at + 4)) {
      return 1;
    }
    at += 12 + reader.getUint32(at);
  }
  return 1;
}

function gifFrames(bytes: Uint8Array): number {
  let at = 13 + colourTableBytes(bytes[10] ?? 0);
  let count = 0;
  while (at < bytes.byteLength) {
    if (bytes[at] === GIF_IMAGE_DESCRIPTOR) {
      count += 1;
      at = subBlocksEnd(bytes, at + 11 + colourTableBytes(bytes[at + 9] ?? 0));
    } else if (bytes[at] === GIF_EXTENSION) {
      at = subBlocksEnd(bytes, at + 2);
    } else {
      break;
    }
  }
  return count;
}

function colourTableBytes(packed: number): number {
  return (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
}

function subBlocksEnd(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at < bytes.byteLength) {
    const size = bytes[at] ?? 0;
    if (size === 0) {
      return at + 1;
    }
    at += 1 + size;
  }
  return bytes.byteLength;
}

const FRAME_READERS: Partial<
  Record<ImageMimeType, (bytes: Uint8Array) => number>
> = {
  "image/webp": webpFrames,
  "image/png": apngFrames,
  "image/gif": gifFrames,
};

/** Headers only: the count has to be read before the resize, which keeps frame 1 alone. */
function frames(bytes: Uint8Array, mimeType: ImageMimeType): number {
  return Math.max(1, FRAME_READERS[mimeType]?.(bytes) ?? 1);
}

/** An unknown model is not a blind one: only a model that names its inputs can rule the picture out. */
function canSee(model: VisionModel | undefined): boolean {
  return model === undefined || model.input.includes("image");
}

/** What a model without eyes is told in place of the picture it cannot be sent. */
function noVisionNote(tool: string, subject: string): string {
  return `[${tool} tool: ${subject}; the current model has no vision input.]`;
}

/** A name that claims a picture — a claim the bytes still have to back. */
function looksLikeImageName(path: string): boolean {
  return ImageMime.namesExtension(extname(path).slice(1).toLowerCase());
}

/** What the spill cache holds the picture under; the resize picks the extension, never the source path. */
function cacheName(sha256: string, mimeType: ImageMimeType): string {
  return `${CACHE_PREFIX}${sha256}.${ImageMime.extensionOf(mimeType)}`;
}

/** Refuse on the stat alone, so a mislabelled video is never pulled into memory. */
function assertWithinSourceCap(byteLength: number, path: string): void {
  if (byteLength > MAX_SOURCE_BYTES) {
    throw new Error(
      `Image is ${Format.bytes(byteLength)}, over the ${Format.bytes(MAX_SOURCE_BYTES)} read cap. Shrink it first: magick ${path} -resize ${MAX_EDGE}x${MAX_EDGE} /tmp/small.png`
    );
  }
}

async function normalise(
  bytes: Uint8Array,
  path: string
): Promise<NormalisedImage> {
  assertWithinSourceCap(bytes.byteLength, path);

  const sniffed = sniff(bytes);
  if (sniffed === null) {
    throw new Error(
      `File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: ${describe(bytes)}. This usually means a download saved an error page instead of the image. Use bash: file ${path}`
    );
  }

  const resized = await resizeImage(bytes, sniffed, {
    maxWidth: MAX_EDGE,
    maxHeight: MAX_EDGE,
    maxBytes: MAX_ENCODED_BYTES,
  });
  if (resized === null) {
    throw new Error(
      `Could not shrink ${path} (${Format.bytes(bytes.byteLength)}) under the ${Format.bytes(MAX_ENCODED_BYTES)} provider limit. Re-save it smaller: magick ${path} -resize ${MAX_EDGE}x${MAX_EDGE} -quality 80 /tmp/small.jpg`
    );
  }

  // An unresized encode is the input re-spelled: decoding it back would copy the bytes twice.
  const data = resized.wasResized ? Buffer.from(resized.data, "base64") : bytes;
  const mimeType = ImageMime.isSupported(resized.mimeType)
    ? resized.mimeType
    : sniffed;
  const sha256 = Bun.SHA256.hash(data, "hex");

  return {
    base64: resized.data,
    mimeType,
    width: resized.width,
    height: resized.height,
    bytes: data.byteLength,
    originalWidth: resized.originalWidth,
    originalHeight: resized.originalHeight,
    originalMimeType: sniffed,
    resized:
      resized.width !== resized.originalWidth ||
      resized.height !== resized.originalHeight,
    frames: frames(bytes, sniffed),
    sha256,
    cachePath: await SpillCache.writeNamed(cacheName(sha256, mimeType), data),
  };
}

/** The record of the picture a tool hands its view, off the picture itself. */
function detailsOf(image: NormalisedImage): ImageDetails {
  return {
    sha256: image.sha256,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    resized: image.resized,
    frames: image.frames,
  };
}

/** Text first, the way pi's own read orders it. */
function contentOf(image: NormalisedImage, note?: string): ToolContent {
  const picture = {
    type: "image" as const,
    data: image.base64,
    mimeType: image.mimeType,
  };
  return note === undefined
    ? [picture]
    : [{ type: "text", text: note }, picture];
}

/** How the model maps coordinates it reads off the picture back onto the file. */
function resizeNote(image: NormalisedImage): string | undefined {
  if (!image.resized) {
    return undefined;
  }
  const scale = (image.originalWidth / image.width).toFixed(2);
  return `image resized from ${image.originalWidth}x${image.originalHeight} to ${image.width}x${image.height}; multiply coordinates by ${scale} to map to the original.`;
}

/**
 * What the picture leaves out, which a still under every cap says nothing about:
 * providers see one frame, so an unmentioned animation reads as an empty screen.
 */
function animationNote(image: NormalisedImage): string | undefined {
  if (image.frames < 2) {
    return undefined;
  }
  return `animated ${ImageMime.extensionOf(image.originalMimeType)}: ${image.frames} frames, ${image.originalWidth}x${image.originalHeight}; frame 1 shown.`;
}

/** Everything true of the picture that is not in the picture. */
function noteOf(image: NormalisedImage): string | undefined {
  const notes = [resizeNote(image), animationNote(image)].filter(
    (note) => note !== undefined
  );
  return notes.length === 0 ? undefined : notes.join(" ");
}

/** What the bytes are instead, in the words a person would use to go find them. */
function describe(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "an empty file";
  }
  if (startsWith(bytes, PDF)) {
    return "PDF document";
  }
  if (startsWith(bytes, ZIP)) {
    return "ZIP archive (.pptx/.docx/.xlsx are ZIPs)";
  }

  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/^<(?:!doctype html|html|head|body)\b/i.test(head)) {
    return "HTML document";
  }
  if (!Lines.isBinaryBytes(bytes)) {
    return "JSON or text";
  }
  return `unrecognized bytes (hex: ${hex(bytes)})`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join(" ");
}

export const Images = {
  MAX_SOURCE_BYTES,
  SNIFF_BYTES,
  CACHE_PREFIX,
  sniff,
  frames,
  isSupported: ImageMime.isSupported,
  canSee,
  noVisionNote,
  extensionOf: ImageMime.extensionOf,
  looksLikeImageName,
  assertWithinSourceCap,
  normalise,
  detailsOf,
  contentOf,
  noteOf,
  cacheName,
};
