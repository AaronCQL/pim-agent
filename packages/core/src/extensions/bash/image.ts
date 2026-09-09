import { Format } from "../../shared/Format";
import { Images, type NormalisedImage } from "../../shared/Images";

/**
 * The picture stdout printed, once a provider will take it. Bytes that sniffed
 * as an image but cannot be decoded are not an error here: the command ran, and
 * bash reports what it printed.
 */
export async function normaliseStdoutImage(
  bytes: Uint8Array
): Promise<NormalisedImage | null> {
  try {
    return await Images.normalise(bytes, "stdout");
  } catch {
    return null;
  }
}

/** `stdout is a 1200x800 png (240 KB)`, the subject every note about the picture shares. */
export function imageSubject(image: NormalisedImage): string {
  return `stdout is a ${image.width}x${image.height} ${Images.extensionOf(image.mimeType)} (${Format.bytes(image.bytes)})`;
}

/** What the model is told next to the picture, or instead of it when it has no eyes. */
export function imageNote(image: NormalisedImage, vision: boolean): string {
  if (!vision) {
    return Images.noVisionNote("bash", imageSubject(image));
  }
  const note = Images.noteOf(image);
  return `[bash tool: ${imageSubject(image)}, shown as an image.${note ? ` ${note}` : ""}]`;
}
