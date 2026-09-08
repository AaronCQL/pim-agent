import { onCleanup } from "solid-js";

/** What a pushed entry is marked with, so only an overlay's pop is ours. */
const MODAL_ENTRY = { pimModal: true };

export type BackGuard = {
  /** The overlay is up: Back now closes it instead of leaving the page. */
  readonly arm: () => void;
  /** It closed, however it closed — give the entry back if it is still ours. */
  readonly release: () => void;
};

/**
 * **Back closes the overlay.** Opening pushes a history entry and closing pops
 * it, so the phone gesture for "out of this" leaves the thing on top rather
 * than the session under it — an overlay that Back cannot dismiss is a trap on
 * the one device that has no ESC.
 *
 * Shared by every `showModal()` wrapper that covers the session, because the
 * bookkeeping is the whole of the feature and two copies of it drift: the
 * entry has to be given back however the overlay was closed — a close button,
 * ESC, the backdrop, or the state behind it going away — and exactly once, or
 * a stray `history.back()` navigates the app.
 */
export function createBackGuard(onBack: () => void): BackGuard {
  // Whether the entry on top of the history stack is this overlay's.
  let pushed = false;

  const onPopState = (): void => {
    // The reader popped it themselves, so there is nothing left to unwind.
    pushed = false;
    onBack();
  };

  const release = (): void => {
    globalThis.removeEventListener("popstate", onPopState);
    if (pushed) {
      pushed = false;
      history.back();
    }
  };

  onCleanup(release);

  return {
    arm: () => {
      pushed = true;
      history.pushState(MODAL_ENTRY, "");
      globalThis.addEventListener("popstate", onPopState);
    },
    release,
  };
}
