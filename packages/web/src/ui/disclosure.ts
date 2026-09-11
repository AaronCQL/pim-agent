import { createEffect, createSignal, untrack, type Accessor } from "solid-js";

import { createMediaQuery, KEYBOARD } from "./media";

export type Disclosure = {
  readonly open: Accessor<boolean>;
  readonly toggle: () => void;
  readonly close: () => void;
  /** The whole control, panel included: a pointer landing outside it dismisses. */
  readonly root: (element: HTMLElement) => void;
  readonly trigger: (element: HTMLElement) => void;
  /** The trigger, for a panel that positions itself against it. */
  readonly anchor: () => HTMLElement;
  /** The panel's filter box, if it has one; cleared on the way out and focused on the way in. */
  readonly field: (element: HTMLInputElement) => void;
};

/** A panel a chip opens: what closes it, what it clears, and where focus goes. */
export function createDisclosure(
  options: {
    readonly onOpen?: () => void;
    readonly onClose?: () => void;
  } = {}
): Disclosure {
  const [open, setOpen] = createSignal(false);
  const keyboard = createMediaQuery(KEYBOARD);
  let root: HTMLElement | undefined;
  // Definite: nothing reads the anchor before the trigger's ref has run, and
  // the panel it positions cannot be open before that either.
  let trigger!: HTMLElement;
  let field: HTMLInputElement | undefined;

  createEffect(
    () => open(),
    (isOpen) => {
      if (!isOpen) {
        options.onClose?.();
        // The box is uncontrolled, so it keeps what was typed until told otherwise.
        if (field) {
          field.value = "";
        }
        if (document.activeElement === field) {
          trigger.focus();
        }
        return;
      }
      options.onOpen?.();
      // Focus in a microtask: the panel is shown by another effect, and a hidden field cannot take focus.
      if (untrack(keyboard)) {
        queueMicrotask(() => {
          field?.focus();
        });
      }
      const dismiss = (event: PointerEvent): void => {
        // Test the whole control, chip and panel: a chip-only test closes the list under a touch scroll of a row.
        if (root && !root.contains(event.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener("pointerdown", dismiss, true);
      // Return the cleanup: an effect callback is not an owner, so `onCleanup` here would never run.
      return () => {
        document.removeEventListener("pointerdown", dismiss, true);
      };
    }
  );

  return {
    open,
    toggle: () => {
      setOpen((was) => !was);
    },
    close: () => {
      setOpen(false);
    },
    root: (element: HTMLElement) => {
      root = element;
    },
    trigger: (element: HTMLElement) => {
      trigger = element;
    },
    anchor: () => trigger,
    field: (element: HTMLInputElement) => {
      field = element;
    },
  };
}
