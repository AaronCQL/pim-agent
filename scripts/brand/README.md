# PIM logo

Handcrafted Sprout pixel lettering in indigo-400 (`#818cf8`).

```sh
bun run gen:brand
```

Six assets are generated in `assets/brand/`:

- `wordmark.svg` — transparent PIM wordmark for the topnav and branding.
- `favicon.svg` — indigo P on a dark background, aligned to a 16×16 grid.
- `apple-touch-icon.png` — opaque 180×180 P icon for Apple bookmarks.
- `icon-192.png`, `icon-512.png` — opaque square P icons the web app manifest points at.
- `icon-maskable.png` — the same 512×512 mark with a second cell of padding, so an Android launcher can mask it to its own shape without clipping the P.

`manifest.webmanifest` sits beside them and is hand-written, not generated: `display: standalone` is what drops the browser chrome when the app is added to a home screen, and its colours match the app shell rather than the icon.

Tune `scripts/brand/config.ts`: `color` and `iconBackground` set colours; `pixel` sets cell size; `spacing` and `padding` are measured in cells; `gap` and `radius` are fractions of a cell. Glyph rows use `1` for filled pixels and `0` for empty space.

The favicon intentionally uses square 2×2 cells, ignoring normal size, gap, rounding and padding settings to stay crisp at 16px. Its P must fit in eight rows/columns. The touch icon uses the normal square mark geometry.

SVGs contain shapes, not fonts. The PNG is rendered locally with the dev-only `@resvg/resvg-js`. Regenerate rather than editing the assets.

Vite uses `assets/brand/` as its public directory: dev serves it directly, and the build copies every file into `packages/web/dist/client/` for packaging. Keep documentation and generator sources here, not in the public directory. The app uses `/wordmark.svg` in the desktop sidebar and mobile drawer; `index.html` links the favicon, the touch icon and the manifest. The server revalidates these unhashed assets rather than caching them immutably.

The header uses `h-5` (1.25rem) for a compact wordmark; its width follows the SVG's aspect ratio.
