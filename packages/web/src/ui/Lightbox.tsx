import { createDialog } from "./dialog";

/**
 * A control over the corner of the picture. The disc and its hairline are what
 * keep a glyph legible over an image nobody has seen yet — a bare mark is
 * black on black as often as not — and it is the same chip a delivered picture
 * already wears over its own corner.
 */
const CONTROL =
  "flex items-center justify-center rounded-full bg-neutral-950/80 p-2 text-neutral-350 ring-1 ring-neutral-700 hover:text-neutral-50";

/**
 * One picture, as large as the window allows.
 *
 * `<dialog>.showModal()` again — the same reasoning as the drawer: focus
 * trap, `inert` on the page behind, ESC-to-close and a `::backdrop` are the
 * whole of what a lightbox library sells, and the platform ships them. What
 * is left is a click anywhere closing it, which for a picture is the gesture
 * everyone tries first.
 *
 * There is no zoom of our own. Pinching zooms the visual viewport, and a fixed
 * dialog is magnified with it against the original bytes rather than the
 * scaled raster; where there is no pinch, the corner link hands the file to
 * the browser's own image viewer, which zooms, pans and saves. A tap-to-zoom
 * here would have to take the tap that closes it, to reimplement all three.
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
      // `m-auto` is what centres a modal dialog in the viewport, and it is
      // spelled out because the CSS reset zeroes the margin the UA sheet
      // relies on for it. Nothing is positioned against the dialog: `:modal`
      // is fixed, so it is already the containing block its controls anchor
      // to.
      class="m-auto max-h-screen max-w-screen border-none bg-transparent p-0 backdrop:bg-black/80"
    >
      <img
        src={props.src}
        alt={props.alt}
        // `block`, or the line box under an inline image leaves a strip of
        // dialog below the picture for the backdrop click to land on.
        class="block max-h-[92vh] max-w-[92vw] rounded-lg object-contain"
      />

      {/* Over the corner rather than in a header bar: this is one picture as
          large as the window allows, and a bar naming it would be a second
          panel around it. On a phone they are also the only way out that can
          be seen — a tap on the picture is what someone does when they mean
          "bigger", not "gone".

          Neither stops the click reaching the dialog, so both close the
          lightbox. For the link that is the point: the navigation is already
          queued, and getting the reduced copy out of the way is what "open the
          original" meant. */}
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
