import { createSignal } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import type { AttachmentTile } from "../view/Attachments";

export type Uploads = {
  readonly tiles: () => readonly AttachmentTile[];
  readonly failed: () => string;
  readonly absorb: (files: readonly File[]) => Promise<void>;
  readonly reset: () => void;
};

/** The upload half of the composer: local previews, the last failure, and the fan-out that starts them. */
export function createUploads(store: SessionStore): Uploads {
  const [failed, setFailed] = createSignal("");
  const [uploading, setUploading] = createSignal<readonly AttachmentTile[]>([]);
  let previews = 0;

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
