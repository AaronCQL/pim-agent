import { createEffect } from "solid-js";

/**
 * One picture, as large as the window allows.
 *
 * `<dialog>.showModal()` again — the same reasoning as the drawer: focus
 * trap, `inert` on the page behind, ESC-to-close and a `::backdrop` are the
 * whole of what a lightbox library sells, and the platform ships them. What
 * is left is a click anywhere closing it, which for a picture is the gesture
 * everyone tries first.
 *
 * Mounted only while it is open, by the caller: a transcript is fifty
 * messages long, and fifty dialogs that are almost never shown is a page
 * built to be closed.
 */
export function Lightbox(props: {
  readonly src: string;
  readonly alt: string;
  readonly onClose: () => void;
}) {
  let host!: HTMLDialogElement;

  // Opened from an effect rather than from the ref: a `<dialog>` must be in
  // the document before it can be shown, and the ref runs before it is.
  createEffect(
    () => props.src,
    () => {
      if (!host.open) {
        host.showModal();
      }
    }
  );

  return (
    <dialog
      ref={(element: HTMLDialogElement) => {
        host = element;
      }}
      aria-label={props.alt}
      onClose={() => {
        props.onClose();
      }}
      onClick={() => {
        host.close();
      }}
      class="max-h-screen max-w-screen border-none bg-transparent p-0 backdrop:bg-black/80"
    >
      <img
        src={props.src}
        alt={props.alt}
        class="max-h-[92vh] max-w-[92vw] rounded-lg object-contain"
      />
    </dialog>
  );
}
