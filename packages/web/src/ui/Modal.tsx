import { createEffect, onCleanup, type Element } from "solid-js";

import { createMediaQuery, DESKTOP } from "./media";

/** What a pushed entry is marked with, so only this modal's pop is ours. */
const MODAL_ENTRY = { pimModal: true };

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
 * **Back closes it.** Opening pushes a history entry and closing pops it, so
 * the phone gesture for "out of this" leaves the modal rather than the
 * session behind it — a modal that Back cannot dismiss is a trap on the one
 * device that has no other way out.
 */
export function Modal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  /** What the modal is, beside its close button. Nothing may mutate. */
  readonly header: Element;
  readonly children: Element;
}) {
  const desktop = createMediaQuery(DESKTOP);
  let host!: HTMLDialogElement;
  // Whether the entry on top of the history stack is this modal's.
  let pushed = false;

  const onPopState = (): void => {
    // The reader popped it themselves, so there is nothing left to unwind.
    pushed = false;
    props.onClose();
  };

  /**
   * Give the history entry back, however the modal was closed — the close
   * button, ESC, the backdrop, or the state behind it going away. Every one of
   * those routes through the dialog's own `close` event, so this is the one
   * place that has to know.
   */
  const release = (): void => {
    globalThis.removeEventListener("popstate", onPopState);
    if (pushed) {
      pushed = false;
      history.back();
    }
  };

  createEffect(
    () => props.open,
    (open) => {
      if (open === host.open) {
        return;
      }
      if (!open) {
        host.close();
        return;
      }
      host.showModal();
      pushed = true;
      history.pushState(MODAL_ENTRY, "");
      globalThis.addEventListener("popstate", onPopState);
    }
  );

  onCleanup(release);

  return (
    <dialog
      ref={(element: HTMLDialogElement) => {
        host = element;
      }}
      aria-label={props.label}
      onClose={() => {
        release();
        props.onClose();
      }}
      onClick={(event: MouseEvent) => {
        if (event.target === host) {
          host.close();
        }
      }}
      class={`max-h-none max-w-none bg-neutral-925 p-0 text-neutral-100 backdrop:bg-black/60 ${
        desktop()
          ? "m-auto h-[85dvh] w-[min(56rem,92vw)] rounded-lg border border-neutral-700"
          : "m-0 h-full w-full border-none"
      }`}
    >
      <div class="flex h-full min-h-0 flex-col">
        <header class="flex items-start gap-3 border-b border-neutral-700 px-3 py-[--line]">
          <div class="min-w-0 grow">{props.header}</div>
          <button
            type="button"
            aria-label="Close"
            class="flex size-6 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-100"
            onClick={() => {
              host.close();
            }}
          >
            <span class="i-solar:close-circle-bold size-5" aria-hidden="true" />
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
