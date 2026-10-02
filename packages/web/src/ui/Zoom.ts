export type Size = { readonly width: number; readonly height: number };

export type Point = { readonly x: number; readonly y: number };

/** `x`, `y` is the top-left corner. */
export type View = {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
};

const FILL = 0.92;
const MAX_SCALE = 4;
const OVERSCROLL = 80;

function fitScale(image: Size, stage: Size): number {
  return Math.min(
    1,
    (stage.width * FILL) / image.width,
    (stage.height * FILL) / image.height
  );
}

function axis(offset: number, drawn: number, room: number): number {
  if (drawn <= room) {
    return (room - drawn) / 2;
  }
  const margin = Math.min(OVERSCROLL, drawn - room);
  return Math.min(margin, Math.max(room - drawn - margin, offset));
}

function clamp(view: View, image: Size, stage: Size): View {
  const scale = Math.min(
    Math.max(view.scale, fitScale(image, stage)),
    MAX_SCALE
  );
  return {
    scale,
    x: axis(view.x, image.width * scale, stage.width),
    y: axis(view.y, image.height * scale, stage.height),
  };
}

function fit(image: Size, stage: Size): View {
  return clamp({ scale: 0, x: 0, y: 0 }, image, stage);
}

function isFitted(view: View, image: Size, stage: Size): boolean {
  return view.scale <= fitScale(image, stage) + 1e-6;
}

/** Keeps the image point under `at` fixed. */
function zoomAt(
  view: View,
  factor: number,
  at: Point,
  image: Size,
  stage: Size
): View {
  const scale = clamp(
    { ...view, scale: view.scale * factor },
    image,
    stage
  ).scale;
  const ratio = scale / view.scale;
  return clamp(
    {
      scale,
      x: at.x - (at.x - view.x) * ratio,
      y: at.y - (at.y - view.y) * ratio,
    },
    image,
    stage
  );
}

function panBy(view: View, by: Point, image: Size, stage: Size): View {
  return clamp({ ...view, x: view.x + by.x, y: view.y + by.y }, image, stage);
}

/** Fitted → actual size (or 2× if it already fits); otherwise → fitted. */
function toggle(view: View, at: Point, image: Size, stage: Size): View {
  if (!isFitted(view, image, stage)) {
    return fit(image, stage);
  }
  const target = Math.max(1, fitScale(image, stage) * 2);
  return zoomAt(view, target / view.scale, at, image, stage);
}

export const Zoom = { fit, isFitted, zoomAt, panBy, toggle };
