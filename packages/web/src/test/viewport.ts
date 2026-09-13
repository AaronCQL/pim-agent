/** A visual viewport under the test's control: the height a software keyboard takes from. */
export function fakeViewport(initialHeight: number): {
  readonly resize: (height: number) => void;
  readonly restore: () => void;
} {
  const real = Object.getOwnPropertyDescriptor(globalThis, "visualViewport");
  let height = initialHeight;
  const viewport = new EventTarget();
  Object.defineProperty(viewport, "height", { get: () => height });
  Object.defineProperty(globalThis, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return {
    resize: (next: number) => {
      height = next;
      viewport.dispatchEvent(new Event("resize"));
    },
    restore: () => {
      if (real) {
        Object.defineProperty(globalThis, "visualViewport", real);
      } else {
        Reflect.deleteProperty(globalThis, "visualViewport");
      }
    },
  };
}
