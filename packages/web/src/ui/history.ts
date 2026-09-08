import { onCleanup } from "solid-js";

const MODAL_ENTRY = { pimModal: true };

export type BackGuard = {
  readonly arm: () => void;
  readonly release: () => void;
};

/** Back closes the overlay: `arm` pushes a history entry, `release` pops it exactly once — popping twice navigates the app. */
export function createBackGuard(onBack: () => void): BackGuard {
  let pushed = false;

  const onPopState = (): void => {
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
