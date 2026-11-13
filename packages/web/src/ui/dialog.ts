import { createEffect, untrack } from "solid-js";

import { createBackGuard } from "./history";
import { createMediaQuery, KEYBOARD } from "./media";

/** Closing refocuses what had the focus, and a refocused text field raises the soft keyboard. */
function dropTextFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches("input, textarea")) {
    active.blur();
  }
}

export type Dialog = {
  readonly ref: (element: HTMLDialogElement) => void;
  readonly close: () => void;
  readonly onNativeClose: () => void;
  readonly isHost: (target: EventTarget | null) => boolean;
};

export function createDialog(options: {
  readonly open: () => boolean;
  readonly onClose: () => void;
}): Dialog {
  let host!: HTMLDialogElement;
  const keyboard = createMediaQuery(KEYBOARD);
  const back = createBackGuard(() => {
    host.close();
  });

  // Not from the ref: a `<dialog>` must be in the document to be shown.
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
      if (!untrack(keyboard)) {
        dropTextFocus();
      }
      host.showModal();
      back.arm();
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
      back.release();
      options.onClose();
    },
    isHost: (target: EventTarget | null) => target === host,
  };
}
