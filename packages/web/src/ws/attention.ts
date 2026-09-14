/** A visible document holding the focus: the reader is looking at this tab. */
function attentive(): boolean {
  const view = globalThis.document as Document | undefined;
  return (
    view === undefined ||
    (view.visibilityState === "visible" && view.hasFocus())
  );
}

/**
 * Reports attention now and on every change to it, and returns the disposer
 * that takes the listeners back off. Outside a browser the reader is assumed
 * present, and nothing is listened for.
 */
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
