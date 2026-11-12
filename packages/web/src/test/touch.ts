type Point = { readonly x: number; readonly y: number };

function fire(type: string, target: Element, at: Point | undefined): void {
  const touches =
    at === undefined
      ? []
      : [
          new Touch({
            identifier: 1,
            target,
            clientX: at.x,
            clientY: at.y,
          }),
        ];
  target.dispatchEvent(
    new TouchEvent(type, { touches, bubbles: true, cancelable: true })
  );
}

/** One finger from `from` to `to` in a few moves, then lifted. */
export function drag(target: Element, from: Point, to: Point): void {
  const steps = 4;
  fire("touchstart", target, from);
  for (let step = 1; step <= steps; step += 1) {
    fire("touchmove", target, {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    });
  }
  fire("touchend", target, undefined);
}
