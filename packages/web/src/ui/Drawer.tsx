import { createEffect, type Element } from "solid-js";

/**
 * A left sheet, and the only overlay primitive `ui/` adds for mobile.
 *
 * `<dialog>.showModal()` again: focus trap, `inert` on the rest of the
 * document, ESC-to-close and `::backdrop` are the parts a drawer library
 * exists to supply, and the platform already has them. What is left is the
 * geometry — full height, pinned to the inline start — plus closing on a
 * backdrop tap, which is a click on the dialog box itself because the backdrop
 * is not an element.
 *
 * No slide-in: a `<dialog>` toggles `display`, so animating it needs
 * `@starting-style` and discrete transitions, which is a lot of machinery for
 * a frame of motion the mockup never asked for.
 */
export function Drawer(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly children: Element;
}) {
  let host!: HTMLDialogElement;

  createEffect(
    () => props.open,
    (open) => {
      if (open === host.open) {
        return;
      }
      if (open) {
        host.showModal();
      } else {
        host.close();
      }
    }
  );

  return (
    <dialog
      ref={(element: HTMLDialogElement) => {
        host = element;
      }}
      aria-label={props.label}
      onClose={() => {
        props.onClose();
      }}
      onClick={(event: MouseEvent) => {
        if (event.target === host) {
          host.close();
        }
      }}
      class="m-0 h-full max-h-none w-[85vw] max-w-xs border-r border-neutral-700 bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/60"
    >
      {props.children}
    </dialog>
  );
}
