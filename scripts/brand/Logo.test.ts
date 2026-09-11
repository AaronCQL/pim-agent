import { expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { iconBackground, style } from "./config";
import { Logo } from "./Logo";

test("the wordmark faithfully draws Sprout in indigo-400 without fonts", () => {
  const logo = Logo.render(style);
  const filled = style.glyphs.flat().join("").replaceAll("0", "").length;
  expect(logo.svg.match(/<rect /g)?.length).toBe(filled);
  expect(logo.svg).not.toContain("<text");
  expect(logo.svg).toContain('fill="#818cf8"');
  const image = new Resvg(logo.svg).render();
  expect(image.width).toBe(logo.width);
  expect(image.height).toBe(logo.height);
  expect(image.pixels[3]).toBe(0);
});

test("favicon pixels are crisp and reproduce P at both native sizes", () => {
  for (const size of [16, 32]) {
    const logo = Logo.render(style, { favicon: true });
    const { pixels, width, height } = new Resvg(logo.svg, {
      fitTo: { mode: "width", value: size },
    }).render();
    expect([width, height]).toEqual([size, size]);
    const rows = style.glyphs[0]!;
    const scale = size / 16;
    const left = Math.floor((16 - rows[0]!.length * 2) / 2) * scale;
    const top = Math.floor((16 - rows.length * 2) / 2) * scale;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const row = Math.floor((y - top) / (2 * scale));
        const column = Math.floor((x - left) / (2 * scale));
        const filled = rows[row]?.[column] === "1";
        expect(pixels[(y * size + x) * 4 + 3]).toBe(filled ? 255 : 0);
      }
    }
  }
});

test("size and padding scale predictably; marks stay square", () => {
  const original = Logo.render(style);
  const doubled = Logo.render({ ...style, pixel: style.pixel * 2 });
  expect(doubled.width).toBe(original.width * 2);
  expect(doubled.height).toBe(original.height * 2);
  const padded = Logo.render({ ...style, padding: 3 });
  expect(padded.width - original.width).toBe(48);
  expect(padded.height - original.height).toBe(48);
  const mark = Logo.render(style, { mark: true });
  expect(mark.width).toBe(mark.height);
});

test("colour, background, and tile geometry remain tunable", () => {
  const logo = Logo.render(
    { ...style, color: "#ff0000", gap: 0.1, radius: 0.125 },
    { background: iconBackground }
  );
  expect(logo.svg).toContain('fill="#ff0000"');
  expect(logo.svg).toContain('width="10.8"');
  expect(logo.svg).toContain('rx="1.5"');
  const image = new Resvg(logo.svg).render();
  expect([...image.pixels.subarray(0, 4)]).toEqual([36, 39, 37, 255]);
});

test("invalid geometry is rejected rather than silently clipped", () => {
  for (const change of [
    { pixel: 0 },
    { gap: 1 },
    { radius: 1 },
    { padding: -1 },
    { spacing: NaN },
  ]) {
    expect(() => Logo.render({ ...style, ...change })).toThrow();
  }
  expect(() =>
    Logo.render({ ...style, glyphs: [["10", "1"], ["1"], ["1"]] })
  ).toThrow();
  expect(() =>
    Logo.render({ ...style, glyphs: [["x"], ["1"], ["1"]] })
  ).toThrow();
  expect(() =>
    Logo.render(
      { ...style, glyphs: [["111111111"], ["1"], ["1"]] },
      { favicon: true }
    )
  ).toThrow();
});

test("attribute values are XML-escaped", () => {
  const logo = Logo.render({ ...style, color: 'red"/><script>&' });
  expect(logo.svg).toContain("red&quot;/&gt;&lt;script&gt;&amp;");
  expect(logo.svg).not.toContain("<script>");
});

test("the public directory holds only the current website exports", async () => {
  const destination = new URL("../../assets/brand/", import.meta.url);
  const files = await Array.fromAsync(
    new Bun.Glob("**/*").scan(destination.pathname)
  );
  expect(files.sort()).toEqual([
    "apple-touch-icon.png",
    "favicon.svg",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable.png",
    "manifest.webmanifest",
    "wordmark.svg",
  ]);
  expect(await Bun.file(new URL("wordmark.svg", destination)).text()).toBe(
    Logo.render(style).svg
  );
  expect(await Bun.file(new URL("favicon.svg", destination)).text()).toBe(
    Logo.render(style, { favicon: true, background: iconBackground }).svg
  );
});

test("every icon PNG is the mark at its declared size", async () => {
  const destination = new URL("../../assets/brand/", import.meta.url);
  const mark = Logo.render(style, { mark: true, background: iconBackground });
  const maskable = Logo.render(
    { ...style, padding: 2 },
    { mark: true, background: iconBackground }
  );
  for (const [name, svg, size] of [
    ["apple-touch-icon.png", mark.svg, 180],
    ["icon-192.png", mark.svg, 192],
    ["icon-512.png", mark.svg, 512],
    ["icon-maskable.png", maskable.svg, 512],
  ] as const) {
    const expected = new Resvg(svg, {
      fitTo: { mode: "width", value: size },
    }).render();
    expect([expected.width, expected.height]).toEqual([size, size]);
    expect(await Bun.file(new URL(name, destination)).bytes()).toEqual(
      new Uint8Array(expected.asPng())
    );
  }
});

test("the manifest drops browser chrome and names icons that exist", async () => {
  const destination = new URL("../../assets/brand/", import.meta.url);
  const manifest = (await Bun.file(
    new URL("manifest.webmanifest", destination)
  ).json()) as {
    readonly display: string;
    readonly start_url: string;
    readonly icons: readonly { readonly src: string; readonly sizes: string }[];
  };
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.map(({ sizes }) => sizes)).toContain("192x192");
  for (const { src } of manifest.icons) {
    expect(src.startsWith("/")).toBe(true);
    expect(await Bun.file(new URL(src.slice(1), destination)).exists()).toBe(
      true
    );
  }
});
