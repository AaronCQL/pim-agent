import { createSignal, onCleanup } from "solid-js";

/** Visible height as a CSS length; unlike `dvh`, it shrinks for the iOS keyboard. */
export function createViewportHeight(): () => string {
  const viewport = globalThis.visualViewport;
  const [height, setHeight] = createSignal(viewport?.height);
  if (viewport) {
    const onResize = (): void => {
      setHeight(viewport.height);
    };
    viewport.addEventListener("resize", onResize);
    onCleanup(() => {
      viewport.removeEventListener("resize", onResize);
    });
  }
  return () => {
    const visible = height();
    return visible === undefined ? "100dvh" : `${visible}px`;
  };
}
