import { createSignal } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import type { AttachmentTile } from "../view/Attachments";

export type Uploads = {
  readonly tiles: () => readonly AttachmentTile[];
  readonly failed: () => string;
  readonly absorb: (files: readonly File[]) => Promise<void>;
  readonly reset: () => void;
};

/**
 * The upload half of the composer: the browser's own preview of bytes on
 * their way to the server, the last failure, and the fan-out that starts
 * them. Nothing here touches the draft, the caret or the pickers.
 */
export function createUploads(store: SessionStore): Uploads {
  const [failed, setFailed] = createSignal("");
  /**
   * Uploads still in flight, drawn from the browser's own copy of the bytes.
   * A photo is on screen the instant it is dropped rather than a round trip
   * later — the wait is the upload, and hiding it until it finishes makes a
   * dropped file look like a file that was refused.
   */
  const [uploading, setUploading] = createSignal<readonly AttachmentTile[]>([]);
  let previews = 0;

  /**
   * Every way bytes get in ends here — drop, paste, and the button. All of
   * them at once rather than one after another: a five-photo drop over a
   * home connection is five uploads, and doing them in turn makes the last
   * one wait for four it has nothing to do with.
   */
  async function absorb(files: readonly File[]): Promise<void> {
    setFailed("");
    await Promise.all(files.map((file) => hoist(file)));
  }

  async function hoist(file: File): Promise<void> {
    const key = `uploading:${++previews}`;
    const preview = URL.createObjectURL(file);
    setUploading((current) => [
      ...current,
      {
        key,
        name: file.name,
        url: preview,
        isImage: file.type.startsWith("image/"),
        uploading: true,
      },
    ]);
    try {
      await store.attachFile(file);
    } catch (err) {
      setFailed(`${file.name}: ${(err as Error).message}`);
    } finally {
      setUploading((current) => current.filter((one) => one.key !== key));
      URL.revokeObjectURL(preview);
    }
  }

  return {
    tiles: uploading,
    failed,
    absorb,
    reset: () => {
      setUploading([]);
    },
  };
}
