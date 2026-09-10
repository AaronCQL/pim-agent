import { getOwner, onCleanup, runWithOwner } from "solid-js";

/** A `ref` reporting an element's height; call it during setup, not inside a `ref`, where there is no owner to run its cleanup. */
export function observeHeight(
  report: (height: number) => void
): (element: HTMLElement) => void {
  const owner = getOwner();
  return (element) => {
    const observer = new ResizeObserver(() => {
      report(element.offsetHeight);
    });
    observer.observe(element);
    runWithOwner(owner, () => {
      onCleanup(() => {
        observer.disconnect();
      });
    });
  };
}
