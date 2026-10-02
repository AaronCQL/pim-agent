function attentive(): boolean {
  const view = globalThis.document as Document | undefined;
  return (
    view === undefined ||
    (view.visibilityState === "visible" && view.hasFocus())
  );
}

/** Reports whether the tab is visible and focused, now and on change. Always true outside a browser. */
export function watchAttention(onChange: (value: boolean) => void): () => void {
  onChange(attentive());
  const view = globalThis.document as Document | undefined;
  if (view === undefined) {
    return () => undefined;
  }
  const report = (): void => {
    onChange(attentive());
  };
  view.addEventListener("visibilitychange", report);
  globalThis.addEventListener("focus", report);
  globalThis.addEventListener("blur", report);
  return () => {
    view.removeEventListener("visibilitychange", report);
    globalThis.removeEventListener("focus", report);
    globalThis.removeEventListener("blur", report);
  };
}
