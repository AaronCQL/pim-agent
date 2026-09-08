import { createDialog } from "./dialog";

const CONTROL =
  "flex items-center justify-center rounded-full bg-neutral-950/80 p-2 text-neutral-350 ring-1 ring-neutral-700 hover:text-neutral-50";

/** One picture, as large as the window allows; the caller mounts it only while it is open. */
export function Lightbox(props: {
  readonly src: string;
  readonly alt: string;
  readonly onClose: () => void;
}) {
  const dialog = createDialog({
    open: () => true,
    onClose: () => {
      props.onClose();
    },
    back: true,
  });

  return (
    <dialog
      ref={dialog.ref}
      aria-label={props.alt}
      onClose={dialog.onNativeClose}
      onClick={dialog.close}
      // `m-auto` centres a modal dialog: the CSS reset zeroes the margin the UA sheet relies on.
      class="m-auto max-h-screen max-w-screen border-none bg-transparent p-0 backdrop:bg-black/80"
    >
      <img
        src={props.src}
        alt={props.alt}
        // `block`, or the line box under an inline image leaves a strip of dialog below the picture.
        class="block max-h-[92vh] max-w-[92vw] rounded-lg object-contain"
      />

      <div class="absolute right-2 top-2 flex gap-1.5">
        <a
          href={props.src}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${props.alt} at full size`}
          class={CONTROL}
        >
          <span
            class="i-griddy-icons:maximize-alt-03 size-4"
            aria-hidden="true"
          />
        </a>
        <button
          type="button"
          aria-label="Close"
          class={CONTROL}
          onClick={() => {
            dialog.close();
          }}
        >
          <span class="i-griddy-icons:close size-4" aria-hidden="true" />
        </button>
      </div>
    </dialog>
  );
}
