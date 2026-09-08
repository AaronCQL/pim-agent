import { createEffect } from "solid-js";

import { createBackGuard } from "./history";

export type Dialog = {
  readonly ref: (element: HTMLDialogElement) => void;
  readonly close: () => void;
  readonly onNativeClose: () => void;
  readonly isHost: (target: EventTarget | null) => boolean;
};

export function createDialog(options: {
  readonly open: () => boolean;
  readonly onClose: () => void;
  readonly back: boolean;
}): Dialog {
  let host!: HTMLDialogElement;
  const back = options.back
    ? createBackGuard(() => {
        host.close();
      })
    : undefined;

  // Opened from an effect rather than from the ref: a `<dialog>` must be in
  // the document before it can be shown, and the ref runs before it is.
  createEffect(
    () => options.open(),
    (open) => {
      if (open === host.open) {
        return;
      }
      if (!open) {
        host.close();
        return;
      }
      host.showModal();
      back?.arm();
    }
  );

  return {
    ref: (element: HTMLDialogElement) => {
      host = element;
    },
    close: () => {
      host.close();
    },
    onNativeClose: () => {
      back?.release();
      options.onClose();
    },
    isHost: (target: EventTarget | null) => target === host,
  };
}
