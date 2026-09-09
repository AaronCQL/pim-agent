import { PimSettings } from "../../shared/PimSettings";
import type { ReadImageDetails } from "./schema";

/** What the file looked like when its picture was last sent to the model. */
export type ImageStamp = {
  readonly mtimeMs: number;
  readonly size: number;
};

type Sent = ImageStamp & { readonly details: ReadImageDetails };

/**
 * The pictures already in this conversation, so a screenshot loop pays the
 * resize once. One instance per extension factory, which is one per session;
 * a resumed session starts empty and re-sends every image once.
 */
export class ImageMemory {
  private readonly sent = new Map<string, Sent>();

  /** The settings flag is the escape hatch, so it is read only once a picture repeats. */
  async recall(
    path: string,
    stamp: ImageStamp
  ): Promise<ReadImageDetails | undefined> {
    const sent = this.sent.get(path);

    if (
      sent === undefined ||
      sent.mtimeMs !== stamp.mtimeMs ||
      sent.size !== stamp.size
    ) {
      return undefined;
    }

    const { dedupImages } = await PimSettings.get("read");
    return dedupImages ? sent.details : undefined;
  }

  remember(path: string, stamp: ImageStamp, details: ReadImageDetails): void {
    this.sent.set(path, { ...stamp, details });
  }
}
