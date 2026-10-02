import { onCleanup } from "solid-js";

const MODAL_ENTRY = { pimModal: true };

type Armed = { readonly onBack: () => void };

const armed: Armed[] = [];
// `release` calls `history.back()`, whose own `popstate` must not close the next overlay.
let retracted = 0;

globalThis.addEventListener("popstate", () => {
  if (retracted > 0) {
    retracted -= 1;
    return;
  }
  armed.pop()?.onBack();
});

export type BackGuard = {
  readonly arm: () => void;
  readonly release: () => void;
};

/** Back closes the innermost armed overlay. `arm` pushes a history entry; `release` pops it. */
export function createBackGuard(onBack: () => void): BackGuard {
  const entry: Armed = { onBack };

  const release = (): void => {
    const at = armed.lastIndexOf(entry);
    if (at < 0) {
      return;
    }
    armed.splice(at, 1);
    retracted += 1;
    history.back();
  };

  onCleanup(release);

  return {
    arm: () => {
      armed.push(entry);
      history.pushState(MODAL_ENTRY, "");
    },
    release,
  };
}
