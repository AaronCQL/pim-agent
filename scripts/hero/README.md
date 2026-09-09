# Hero image

```sh
bun run gen:hero
```

Frames the three raw screenshots in `assets/hero/` — `browser.png`, `tui.png`, `telegram.png` — in matching window chrome and composites them into `assets/hero.webp`.

Nothing here is committed: the `.webp` and everything under `assets/gen/` are generated, only the raw screenshots are tracked. Regenerate rather than editing the output.

`Frame.ts` draws one window: a `#3a4047` titlebar with a top-left label, the minimise/maximise/close glyphs, an optional address pill, rounded corners, a hairline edge and a drop shadow. Every metric is a multiple of `unit`, where `unit = 1` reproduces a 51px titlebar, so chrome stays proportional at any size.

Tune `generate.ts`:

- `inputs.<id>.width` — rendered width in canvas pixels; height follows the source aspect ratio. This also sets the text size, which is `width ÷ source width`. Resize here rather than in an image editor, or the three titlebars stop matching.
- `hero.overlap` — how far each side window laps over the browser, per side. Both windows paint in front, so a larger overlap hides more of the browser and none of the side window. The composition is centred from these, so x positions are derived, never set.
- `hero.top` and `hero.baseline` — the browser's top edge and the shared bottom edge the side windows rest on. These are hand-picked, not derived: change a width and the group no longer centres vertically until they are re-picked.
- `hero.bar` — titlebar height for the whole composite. Scale it with the window widths, otherwise bigger windows get proportionally thinner chrome.
- `elevation` — per-window shadow depth and opacity. Small and strong reads as depth; large and soft reads as haze.

## Layers

`assets/gen/hero/` holds the same composition as separate pieces for hand-placing in an image editor: `background.png` plus one transparent PNG per window, chrome and shadow baked in, all at `layers.scale` (2×). `placement.json` gives the canvas size, the paint order, and the offset of each layer, so dropping them at those coordinates reproduces `hero.webp` exactly.

Move them freely; do not resize them individually. Each window's titlebar scales with its layer, so resizing one alone desynchronises the three.
