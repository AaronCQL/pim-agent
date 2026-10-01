import { createEffect, createSignal, untrack, type Accessor } from "solid-js";

import { createMediaQuery, KEYBOARD } from "./media";

export type Disclosure = {
  readonly open: Accessor<boolean>;
  readonly toggle: () => void;
  readonly close: () => void;
  /** Trigger and panel; a pointerdown outside it closes. */
  readonly root: (element: HTMLElement) => void;
  readonly trigger: (element: HTMLElement) => void;
  readonly anchor: () => HTMLElement;
  /** Optional filter input: focused on open, cleared on close. */
  readonly field: (element: HTMLInputElement) => void;
};

// Eats the click that follows a dismissing pointerdown, so it does not land on what was under the panel.
function swallowPress(): void {
  const drop = (): void => {
    document.removeEventListener("click", swallow, true);
    document.removeEventListener("pointerdown", drop, true);
  };
  function swallow(click: MouseEvent): void {
    if (click.detail === 0) {
      return;
    }
    click.preventDefault();
    click.stopPropagation();
    drop();
  }
  document.addEventListener("click", swallow, true);
  document.addEventListener("pointerdown", drop, true);
}

export function createDisclosure(
  options: {
    readonly onOpen?: () => void;
    readonly onClose?: () => void;
  } = {}
): Disclosure {
  const [open, setOpen] = createSignal(false);
  const keyboard = createMediaQuery(KEYBOARD);
  let root: HTMLElement | undefined;
  let trigger!: HTMLElement;
  let field: HTMLInputElement | undefined;

  createEffect(
    () => open(),
    (isOpen) => {
      if (!isOpen) {
        options.onClose?.();
        if (field) {
          field.value = "";
        }
        if (document.activeElement === field) {
          trigger.focus();
        }
        return;
      }
      options.onOpen?.();
      // Microtask: the panel is shown by another effect, and a hidden field cannot take focus.
      if (untrack(keyboard)) {
        queueMicrotask(() => {
          field?.focus();
        });
      }
      const dismiss = (event: PointerEvent): void => {
        if (root && !root.contains(event.target as Node)) {
          setOpen(false);
          swallowPress();
        }
      };
      document.addEventListener("pointerdown", dismiss, true);
      // `onCleanup` would never run here: an effect callback is not an owner.
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
