import { createEffect, createSignal, onCleanup } from "solid-js";

import { Zoom, type Point, type Size, type View } from "./Zoom";

const TAP_SLOP = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;
const KEY_ZOOM = 1.25;
const KEY_PAN = 80;
const LINE_PX = 16;

export type PanZoom = {
  readonly stageRef: (element: HTMLElement) => void;
  readonly contentRef: (element: HTMLElement) => void;
  readonly view: () => View;
  readonly fitted: () => boolean;
  /** The last press was a tap (not a drag or pinch) off the content. */
  readonly tappedBackdrop: () => boolean;
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onPointerCancel: (event: PointerEvent) => void;
  readonly onWheel: (event: WheelEvent) => void;
  readonly onKeyDown: (event: KeyboardEvent) => void;
};

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** `size` is the content's natural size, undefined until loaded. */
export function createPanZoom(size: () => Size | undefined): PanZoom {
  let stage: HTMLElement | undefined;
  let content: HTMLElement | undefined;
  let natural: Size | undefined;
  let current: View = { scale: 1, x: 0, y: 0 };
  const [view, setView] = createSignal<View>(current);

  const pointers = new Map<number, Point>();
  let travelled = 0;
  let onContent = false;
  let lastTap: { readonly at: Point; readonly time: number } | undefined;

  const stageSize = (): Size => ({
    width: stage?.clientWidth ?? 0,
    height: stage?.clientHeight ?? 0,
  });

  let origin: Point = { x: 0, y: 0 };
  const measure = (): void => {
    const bounds = stage?.getBoundingClientRect();
    origin = { x: bounds?.left ?? 0, y: bounds?.top ?? 0 };
  };
  const local = (event: MouseEvent): Point => ({
    x: event.clientX - origin.x,
    y: event.clientY - origin.y,
  });

  const apply = (change: (view: View, image: Size, stage: Size) => View) => {
    if (!natural) {
      return;
    }
    current = change(current, natural, stageSize());
    setView(current);
  };

  const refit = (): void => {
    apply((_, image, stage) => Zoom.fit(image, stage));
  };
  createEffect(size, (known) => {
    natural = known;
    refit();
  });
  globalThis.addEventListener("resize", refit);
  onCleanup(() => {
    globalThis.removeEventListener("resize", refit);
  });

  const centre = (): Point => {
    const size = stageSize();
    return { x: size.width / 2, y: size.height / 2 };
  };

  const tapped = (event: PointerEvent, at: Point): void => {
    const double =
      lastTap !== undefined &&
      event.timeStamp - lastTap.time < DOUBLE_TAP_MS &&
      distance(lastTap.at, at) < DOUBLE_TAP_SLOP;
    if (!double) {
      lastTap = { at, time: event.timeStamp };
      return;
    }
    lastTap = undefined;
    apply((view, image, stage) => Zoom.toggle(view, at, image, stage));
  };

  const release = (event: PointerEvent): boolean => {
    if (!pointers.delete(event.pointerId)) {
      return false;
    }
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    return true;
  };

  const pan = (by: Point): void => {
    apply((view, image, stage) => Zoom.panBy(view, by, image, stage));
  };
  const zoom = (factor: number): void => {
    const at = centre();
    apply((view, image, stage) => Zoom.zoomAt(view, factor, at, image, stage));
  };
  const zoomIn = (): void => {
    zoom(KEY_ZOOM);
  };
  const keys: Record<string, () => void> = {
    "+": zoomIn,
    "=": zoomIn,
    "-": () => {
      zoom(1 / KEY_ZOOM);
    },
    "0": refit,
    ArrowLeft: () => {
      pan({ x: KEY_PAN, y: 0 });
    },
    ArrowRight: () => {
      pan({ x: -KEY_PAN, y: 0 });
    },
    ArrowUp: () => {
      pan({ x: 0, y: KEY_PAN });
    },
    ArrowDown: () => {
      pan({ x: 0, y: -KEY_PAN });
    },
  };

  return {
    stageRef: (element) => {
      stage = element;
    },
    contentRef: (element) => {
      content = element;
    },
    view,
    fitted: () => {
      const known = size();
      return known === undefined || Zoom.isFitted(view(), known, stageSize());
    },
    tappedBackdrop: () => travelled < TAP_SLOP && !onContent,
    onPointerDown: (event) => {
      if (event.button !== 0) {
        return;
      }
      if (pointers.size === 0) {
        measure();
      }
      stage?.setPointerCapture(event.pointerId);
      const at = local(event);
      pointers.set(event.pointerId, at);
      if (pointers.size === 1) {
        travelled = 0;
        onContent =
          event.target instanceof Node &&
          content?.contains(event.target) === true;
      } else {
        travelled = Number.POSITIVE_INFINITY;
      }
    },
    onPointerMove: (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) {
        return;
      }
      const next = local(event);
      if (pointers.size === 1) {
        travelled += distance(previous, next);
        apply((view, image, stage) =>
          Zoom.panBy(
            view,
            { x: next.x - previous.x, y: next.y - previous.y },
            image,
            stage
          )
        );
      } else {
        const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
        if (other) {
          const before = midpoint(previous, other);
          const after = midpoint(next, other);
          const spread = distance(previous, other);
          apply((view, image, stage) => {
            const zoomed =
              spread > 0
                ? Zoom.zoomAt(
                    view,
                    distance(next, other) / spread,
                    before,
                    image,
                    stage
                  )
                : view;
            return Zoom.panBy(
              zoomed,
              { x: after.x - before.x, y: after.y - before.y },
              image,
              stage
            );
          });
        }
      }
      pointers.set(event.pointerId, next);
    },
    onPointerUp: (event) => {
      const at = pointers.get(event.pointerId);
      if (!release(event) || !at) {
        return;
      }
      if (pointers.size === 0 && travelled < TAP_SLOP) {
        if (onContent) {
          tapped(event, at);
        } else {
          lastTap = undefined;
        }
      }
    },
    onPointerCancel: (event) => {
      release(event);
      travelled = Number.POSITIVE_INFINITY;
    },
    onWheel: (event) => {
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? stageSize().height
            : 1;
      const factor = Math.exp(
        -event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.002)
      );
      measure();
      const at = local(event);
      apply((view, image, stage) =>
        Zoom.zoomAt(view, factor, at, image, stage)
      );
    },
    onKeyDown: (event) => {
      const action = keys[event.key];
      if (action && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        action();
      }
    },
  };
}
