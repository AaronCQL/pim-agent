import { onCleanup } from "solid-js";

const MODAL_ENTRY = { pimModal: true };

type Armed = { readonly onBack: () => void };

const armed: Armed[] = [];
// A `release` reaches this listener as a `popstate` of its own; count those out, or one closes the overlay handed to next.
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

/** Back closes the innermost armed overlay: `arm` pushes a history entry, `release` takes that entry back. */
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
