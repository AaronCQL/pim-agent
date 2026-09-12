import { getOwner, onCleanup, runWithOwner } from "solid-js";

function observe(
  measure: (element: HTMLElement) => number,
  report: (value: number) => void
): (element: HTMLElement) => void {
  const owner = getOwner();
  return (element) => {
    const observer = new ResizeObserver(() => {
      report(measure(element));
    });
    observer.observe(element);
    runWithOwner(owner, () => {
      onCleanup(() => {
        observer.disconnect();
      });
    });
  };
}

/** A `ref` reporting an element's height; call it during setup, not inside a `ref`, where there is no owner to run its cleanup. */
export function observeHeight(
  report: (height: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetHeight, report);
}

/** A `ref` reporting an element's width, under the same rule as `observeHeight`. */
export function observeWidth(
  report: (width: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetWidth, report);
}
