import {
  Images,
  type NormalisedImage,
  type VisionModel,
} from "../../shared/Images";
import type { ReadImageDetails } from "./schema";

export type ImageReadOutcome = {
  readonly kind: "image";
  readonly image: NormalisedImage;
  readonly details: ReadImageDetails;
};

/** The picture is already in the transcript: the row still draws it, the model is only told so. */
export type UnchangedImageReadOutcome = {
  readonly kind: "image-unchanged";
  readonly details: ReadImageDetails;
};

/** Bytes that are a picture, or a name that claims one — a claim that fails is a diagnostic, not text. */
export function isImageRead(head: Uint8Array, path: string): boolean {
  return Images.sniff(head) !== null || Images.looksLikeImageName(path);
}

/** Both refusals that must land before the file is pulled into memory. */
export function assertImageReadable(
  path: string,
  sizeOnDisk: number,
  model: VisionModel | undefined
): void {
  if (model !== undefined && !model.input.includes("image")) {
    throw new Error(
      `Cannot read images: the current model (${model.id}) has no vision input. Switch models with /model, or inspect it with bash: file ${path}`
    );
  }
  Images.assertWithinSourceCap(sizeOnDisk, path);
}

export async function readImage(
  bytes: Uint8Array,
  path: string
): Promise<ImageReadOutcome> {
  const image = await Images.normalise(bytes, path);
  return {
    kind: "image",
    image,
    details: {
      kind: "image",
      absolutePath: path,
      ...Images.detailsOf(image),
    },
  };
}

export function unchangedImageNote(path: string): string {
  return `[read tool: ${path} is unchanged since it was read earlier in this conversation; use the image already above. Touch the file or read a different path to force a re-send.]`;
}
