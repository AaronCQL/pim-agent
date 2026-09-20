import type { Element } from "solid-js";

import { createDialog } from "./dialog";
import { createMediaQuery, DESKTOP } from "./media";
import { createViewportHeight } from "./viewport";

const PANEL = {
  wide: "h-[85dvh] max-h-none w-[min(56rem,92vw)]",
  column: "h-[70dvh] max-h-none w-[min(30rem,92vw)]",
  narrow: "max-h-[85dvh] w-[min(30rem,92vw)]",
} as const;

/** The keys a focused control activates on, which are never the panel's to claim. */
const ACTIVATION = new Set(["Enter", " ", "Tab"]);

/**
 * One thing read on top of everything else: a full-screen sheet on a phone, a
 * centred panel otherwise. A dialog focuses itself as it opens — the first
 * control it finds, which is the close button in the header — so a panel with
 * a field to type in marks that field `autofocus`, the one thing those
 * focusing steps read ahead of them.
 */
export function Modal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly header: Element;
  /** `wide` and `column` are panels of fixed height, the second cut to what a list is read at; `narrow` ends where its content does. */
  readonly size?: keyof typeof PANEL;
  /**
   * The shortcuts belong to the dialog rather than to whichever field inside
   * it holds focus, so a click that lands on a row keeps them alive. What a
   * focused control would activate on stays that control's: Enter on a button
   * is its own click, and claiming it here would cancel it.
   */
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly children: Element;
}) {
  const desktop = createMediaQuery(DESKTOP);
  const viewportHeight = createViewportHeight();
  const dialog = createDialog({
    open: () => props.open,
    onClose: () => {
      props.onClose();
    },
  });

  return (
    <dialog
      ref={dialog.ref}
      aria-label={props.label}
      onClose={dialog.onNativeClose}
      onKeyDown={(event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName === "BUTTON" && ACTIVATION.has(event.key)) {
          return;
        }
        props.onKeyDown?.(event);
      }}
      onClick={(event: MouseEvent) => {
        if (dialog.isHost(event.target)) {
          dialog.close();
        }
      }}
      style={{ height: desktop() ? undefined : viewportHeight() }}
      class={`max-w-none flex-col overflow-hidden bg-neutral-925 p-0 text-neutral-100 backdrop:bg-black/60 open:flex ${
        desktop()
          ? `m-auto rounded-lg ring-1 ring-neutral-700 ${PANEL[props.size ?? "wide"]}`
          : "m-0 max-h-none w-full"
      }`}
    >
      <div class="flex min-h-0 flex-1 flex-col">
        <header class="flex items-start gap-3 border-b border-neutral-700 px-3 py-[calc(var(--line)/2)]">
          <div class="flex min-h-8 min-w-0 grow flex-col justify-center">
            {props.header}
          </div>
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
