import { describe, expect, test } from "bun:test";

import { Zoom } from "./Zoom";

const STAGE = { width: 1000, height: 500 };
const PHOTO = { width: 4000, height: 1000 };
const ICON = { width: 100, height: 50 };

describe("Zoom", () => {
  test("a large picture fits inside the stage, centred, with a margin", () => {
    const view = Zoom.fit(PHOTO, STAGE);

    expect(view.scale).toBeCloseTo(0.23);
    expect(view.x).toBeCloseTo(40);
    expect(view.y).toBeCloseTo((500 - 1000 * 0.23) / 2);
    expect(Zoom.isFitted(view, PHOTO, STAGE)).toBe(true);
  });

  test("a small picture is never blown up to fit", () => {
    expect(Zoom.fit(ICON, STAGE)).toEqual({ scale: 1, x: 450, y: 225 });
  });

  test("the point under the cursor stays under it as the scale changes", () => {
    const fitted = Zoom.fit(PHOTO, STAGE);
    const at = { x: 300, y: 250 };
    const before = {
      x: (at.x - fitted.x) / fitted.scale,
      y: (at.y - fitted.y) / fitted.scale,
    };

    const zoomed = Zoom.zoomAt(fitted, 2, at, PHOTO, STAGE);

    expect(zoomed.scale).toBeCloseTo(fitted.scale * 2);
    expect(zoomed.x + before.x * zoomed.scale).toBeCloseTo(at.x);
    expect(zoomed.y + before.y * zoomed.scale).toBeCloseTo(at.y);
  });

  test("the scale stays between fitted and four times actual pixels", () => {
    const fitted = Zoom.fit(PHOTO, STAGE);
    const centre = { x: 500, y: 250 };

    expect(Zoom.zoomAt(fitted, 0.1, centre, PHOTO, STAGE)).toEqual(fitted);
    expect(Zoom.zoomAt(fitted, 1000, centre, PHOTO, STAGE).scale).toBe(4);
  });

  test("a pan stops a strip of backdrop past the picture's edge, and does nothing along an axis it fits", () => {
    const zoomed = Zoom.zoomAt(
      Zoom.fit(PHOTO, STAGE),
      2,
      { x: 500, y: 250 },
      PHOTO,
      STAGE
    );

    const far = Zoom.panBy(zoomed, { x: 99_999, y: 99_999 }, PHOTO, STAGE);
    expect(far.x).toBe(80);
    expect(far.y).toBe(zoomed.y);

    const back = Zoom.panBy(zoomed, { x: -99_999, y: 0 }, PHOTO, STAGE);
    expect(back.x).toBeCloseTo(STAGE.width - PHOTO.width * zoomed.scale - 80);
  });

  test("the strip grows from nothing as the picture outgrows the stage", () => {
    const wide = { width: 1010, height: 100 };
    const view = { scale: 1, x: 0, y: 0 };

    expect(Zoom.panBy(view, { x: 99_999, y: 0 }, wide, STAGE).x).toBe(10);
    expect(Zoom.panBy(view, { x: -99_999, y: 0 }, wide, STAGE).x).toBe(-20);
  });

  test("a double tap goes to actual pixels, and the next one back to fitted", () => {
    const fitted = Zoom.fit(PHOTO, STAGE);
    const at = { x: 500, y: 250 };

    const actual = Zoom.toggle(fitted, at, PHOTO, STAGE);
    expect(actual.scale).toBe(1);
    expect(Zoom.toggle(actual, at, PHOTO, STAGE)).toEqual(fitted);
  });

  test("a picture already at actual pixels doubles instead", () => {
    const fitted = Zoom.fit(ICON, STAGE);

    expect(Zoom.toggle(fitted, { x: 500, y: 250 }, ICON, STAGE).scale).toBe(2);
  });
});
