/** Calls `onWake` when the page is shown again, restored from bfcache, or back online. */
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
