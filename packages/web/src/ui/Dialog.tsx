import { createEffect, type Element } from "solid-js";

/**
 * The only wrapper feature code may use for a modal.
 *
 * `<dialog>.showModal()` is the platform primitive: focus trap, `inert` on the
 * rest of the document, ESC-to-close and `::backdrop` all come from the UA, so
 * the parts a headless library exists to supply are already here.
 */
export function Dialog(props: {
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
      class="m-auto max-h-[80dvh] w-[min(36rem,92vw)] rounded-lg border border-neutral-800 bg-neutral-950 p-0 text-neutral-200 backdrop:bg-black/60"
    >
      {props.children}
    </dialog>
  );
}
