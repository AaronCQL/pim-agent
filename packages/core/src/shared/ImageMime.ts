export type ImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} satisfies Record<ImageMimeType, string>;

/** Includes both `jpg` and `jpeg`. */
const NAME_EXTENSIONS = new Set([
  ...Object.values(EXTENSIONS),
  ...Object.keys(EXTENSIONS).map((mimeType) => mimeType.slice("image/".length)),
]);

function extensionOf(mimeType: ImageMimeType): string {
  return EXTENSIONS[mimeType];
}

function isSupported(mimeType: string): mimeType is ImageMimeType {
  return Object.hasOwn(EXTENSIONS, mimeType);
}

/** Takes a bare, lowercased extension. */
function namesExtension(extension: string): boolean {
  return NAME_EXTENSIONS.has(extension);
}

/** Browser-safe: no Node imports. */
export const ImageMime = { extensionOf, isSupported, namesExtension };
