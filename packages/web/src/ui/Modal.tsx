import type { Element } from "solid-js";

import { createDialog } from "./dialog";
import { createMediaQuery, DESKTOP } from "./media";

/** One thing read on top of everything else: a full-screen sheet on a phone, a centred panel otherwise. */
export function Modal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly header: Element;
  /** `wide` is a panel of fixed height; `narrow` is a column that ends where its content does. */
  readonly size?: "wide" | "narrow";
  readonly children: Element;
}) {
  const desktop = createMediaQuery(DESKTOP);
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
