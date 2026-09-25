/**
 * Calls `onWake` whenever the page comes back — shown again, restored from the
 * back/forward cache, or back online — and returns the disposer. Outside a
 * browser nothing is listened for.
 */
export function watchWake(onWake: () => void): () => void {
  const view = globalThis.document as Document | undefined;
  if (view === undefined) {
    return () => undefined;
  }
  const shown = (): void => {
    if (view.visibilityState === "visible") {
      onWake();
    }
  };
  view.addEventListener("visibilitychange", shown);
  globalThis.addEventListener("pageshow", onWake);
  globalThis.addEventListener("online", onWake);
  return () => {
    view.removeEventListener("visibilitychange", shown);
    globalThis.removeEventListener("pageshow", onWake);
    globalThis.removeEventListener("online", onWake);
  };
}
