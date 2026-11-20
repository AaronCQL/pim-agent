import { onCleanup } from "solid-js";

/**
 * A ref whose setup is undone when the calling component is disposed. Call during component setup:
 * a ref callback owns nothing, so it cannot register cleanup itself.
 */
export function ownedRef<T extends Element>(
  setup: (element: T) => () => void
): (element: T) => void {
  const teardowns: (() => void)[] = [];
  onCleanup(() => {
    for (const teardown of teardowns) {
      teardown();
    }
  });
  return (element) => {
    teardowns.push(setup(element));
  };
}
