import { createSignal, onCleanup } from "solid-js";

/**
 * The height the page is really visible in, as a CSS length. `dvh` does not
 * follow the software keyboard on iOS — only the visual viewport shrinks — and
 * a top-layer `<dialog>` measures the layout viewport whatever the page does.
 */
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
