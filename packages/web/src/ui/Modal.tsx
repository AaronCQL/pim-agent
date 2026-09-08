import type { Element } from "solid-js";

import { createDialog } from "./dialog";
import { createMediaQuery, DESKTOP } from "./media";

/**
 * One thing read on top of everything else: a full-screen sheet on a phone, a
 * centred panel where there is room for one.
 *
 * `<dialog>.showModal()` again, for the same reasons the drawer and the
 * lightbox use it — focus trap, `inert` on the page behind, ESC-to-close and a
 * `::backdrop` are the whole of what a modal library sells. The geometry is
 * the only part left, and which geometry is not state: it is the media query,
 * so a window dragged across the breakpoint changes shape without a remount.
 *
 * **Back closes it**, like every other overlay that covers the session.
 */
export function Modal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  /** What the modal is, beside its close button. Nothing may mutate. */
  readonly header: Element;
  /**
   * How much there is to read. `wide` is a panel of fixed height for
   * something browsable; `narrow` is a column that ends where its content
   * does, for a handful of controls that would otherwise sit in a field of
   * empty dialog. A phone gets the same full-screen sheet either way.
   */
  readonly size?: "wide" | "narrow";
  readonly children: Element;
}) {
  const desktop = createMediaQuery(DESKTOP);
  const dialog = createDialog({
    open: () => props.open,
    onClose: () => {
      props.onClose();
    },
    back: true,
  });

  return (
    <dialog
      ref={dialog.ref}
      aria-label={props.label}
      onClose={dialog.onNativeClose}
      onClick={(event: MouseEvent) => {
        if (dialog.isHost(event.target)) {
          dialog.close();
        }
      }}
      class={`max-w-none bg-neutral-925 p-0 text-neutral-100 backdrop:bg-black/60 ${
        desktop()
          ? `m-auto rounded-lg ring-1 ring-neutral-700 ${
              props.size === "narrow"
                ? "max-h-[85dvh] w-[min(30rem,92vw)]"
                : "h-[85dvh] max-h-none w-[min(56rem,92vw)]"
            }`
          : "m-0 h-full max-h-none w-full"
      }`}
    >
      <div class="flex h-full min-h-0 flex-col">
        {/* Half a `--line` either side, not a whole one: the header is a bar
            naming what is below it, and a bar that is mostly air reads as a
            second panel. The hairline is what separates it from the
            transcript; the padding only has to keep the text off that. */}
        <header class="flex items-start gap-3 border-b border-neutral-700 px-3 py-[calc(var(--line)/2)]">
          {/* `min-h-8` is the close button's height, so a one-line title sits
              on the button's centre line instead of riding above it. A header
              taller than the button keeps its first line at the top, where a
              button that closes the whole dialog belongs. */}
          <div class="flex min-h-8 min-w-0 grow flex-col justify-center">
            {props.header}
          </div>
          {/* The icon button the sidebar and topbar draw: a 32px
              `rounded-lg` square with no fill until it is pointed at. A
              round-cornered button around an X, not a circled X floating in
              the corner — the ring in `close-circle-bold` reads as the
              button's own edge and then disagrees with every other button in
              the UI about what shape a button is. */}
          <button
            type="button"
            aria-label="Close"
            class="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-850 hover:text-neutral-50"
            onClick={() => {
              dialog.close();
            }}
          >
            <span class="i-griddy-icons:close size-4" aria-hidden="true" />
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
