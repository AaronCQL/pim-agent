/** The formats every provider we target accepts. */
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

/** Both spellings of every format, so `.jpeg` names a picture as surely as `.jpg`. */
const NAME_EXTENSIONS = new Set([
  ...Object.values(EXTENSIONS),
  ...Object.keys(EXTENSIONS).map((mimeType) => mimeType.slice("image/".length)),
]);

/** The format as a word, in the one spelling the notes, the UI and the cache filename all use. */
function extensionOf(mimeType: ImageMimeType): string {
  return EXTENSIONS[mimeType];
}

function isSupported(mimeType: string): mimeType is ImageMimeType {
  return Object.hasOwn(EXTENSIONS, mimeType);
}

/** Whether a bare, lowercased extension is one of the spellings a picture goes by. */
function namesExtension(extension: string): boolean {
  return NAME_EXTENSIONS.has(extension);
}

/** The format table alone, free of Node so the browser can name a picture too. */
export const ImageMime = { extensionOf, isSupported, namesExtension };
