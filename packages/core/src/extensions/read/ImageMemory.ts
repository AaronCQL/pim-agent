import { PimSettings } from "../../shared/PimSettings";
import type { ReadImageDetails } from "./schema";

type ImageStamp = {
  readonly mtimeMs: number;
  readonly size: number;
};

type Sent = ImageStamp & { readonly details: ReadImageDetails };

/** Images already sent this session, keyed by path. A resumed session starts empty. */
export class ImageMemory {
  private readonly sent = new Map<string, Sent>();

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
