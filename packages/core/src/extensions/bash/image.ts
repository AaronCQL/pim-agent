import { Format } from "../../shared/Format";
import { Images, type NormalisedImage } from "../../shared/Images";

/** Null when the bytes cannot be decoded; that is not a tool error. */
export async function normaliseStdoutImage(
  bytes: Uint8Array
): Promise<NormalisedImage | null> {
  try {
    return await Images.normalise(bytes, "stdout");
  } catch {
    return null;
  }
}

/** e.g. `stdout is a 1200x800 png (240 KB)`. */
function imageSubject(image: NormalisedImage): string {
  return `stdout is a ${image.width}x${image.height} ${Images.extensionOf(image.mimeType)} (${Format.bytes(image.bytes)})`;
}

/** Text sent with the image, or instead of it for a model without vision. */
export function imageNote(image: NormalisedImage, vision: boolean): string {
  if (!vision) {
    return Images.noVisionNote("bash", imageSubject(image));
  }
  const note = Images.noteOf(image);
  return `[bash tool: ${imageSubject(image)}, shown as an image.${note ? ` ${note}` : ""}]`;
}
