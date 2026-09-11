import { encode } from "@jsquash/webp";
import { Resvg } from "@resvg/resvg-js";
import { Frame, type Chrome, type Placed, type Source } from "./Frame";

type Input = {
  readonly file: string;
  readonly chrome: Chrome;
  readonly width: number;
};

const assets = new URL("../../assets/", import.meta.url);
const hero = {
  width: 2560,
  height: 1416,
  bar: 36,
  overlap: { tui: 479, telegram: 194 },
  top: 71,
  baseline: 1345,
};
const unit = hero.bar / 51;

const inputs = {
  tui: {
    file: "tui.png",
    chrome: { title: "Terminal" },
    width: 753,
  },
  browser: {
    file: "browser.png",
    chrome: { title: "Browser", address: "localhost:4319" },
    width: 1779,
  },
  telegram: {
    file: "telegram.png",
    chrome: { title: "Telegram" },
    width: 561,
  },
} satisfies Record<string, Input>;

type Id = keyof typeof inputs;

const layers = { scale: 2, pad: 60, dir: "gen/hero/" };
const elevation = {
  browser: { depth: 14, opacity: 0.62 },
  tui: { depth: 12, opacity: 0.7 },
  telegram: { depth: 12, opacity: 0.7 },
} satisfies Record<Id, { readonly depth: number; readonly opacity: number }>;
const order = ["browser", "tui", "telegram"] as const;

async function load(input: Input): Promise<Source> {
  const bytes = new Uint8Array(
    await Bun.file(new URL(`hero/${input.file}`, assets)).arrayBuffer()
  );
  const header = new DataView(bytes.buffer, 16, 8);
  return {
    data: Buffer.from(bytes).toString("base64"),
    width: header.getUint32(0),
    height: header.getUint32(4),
  };
}

const sources = {
  tui: await load(inputs.tui),
  browser: await load(inputs.browser),
  telegram: await load(inputs.telegram),
};

function raster(svg: string) {
  return new Resvg(svg, { font: { loadSystemFonts: true } }).render();
}

async function webp(svg: string): Promise<Uint8Array> {
  const image = raster(svg);
  const encoded = await encode(
    {
      data: new Uint8ClampedArray(image.pixels),
      width: image.width,
      height: image.height,
      colorSpace: "srgb",
    },
    { quality: 90 }
  );
  return new Uint8Array(encoded);
}

function place(id: Id, width: number, x: number, y: number): Placed {
  return Frame.place(
    {
      id,
      source: sources[id],
      chrome: inputs[id].chrome,
      width,
      unit: (unit * width) / inputs[id].width,
    },
    x,
    y
  );
}

function layer(id: Id): string {
  const scale = layers.scale;
  const pad = layers.pad * scale;
  const placed = place(id, inputs[id].width * scale, pad, pad);
  const { depth, opacity } = elevation[id];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(placed.width + pad * 2)}" height="${Math.round(placed.height + pad * 2)}">`,
    `<defs>${placed.defs}${Frame.shadow("drop", scale, depth, opacity)}</defs>`,
    `<g filter="url(#drop)">${placed.body}</g>`,
    `</svg>`,
  ].join("");
}

function backdrop(): string {
  const width = hero.width * layers.scale;
  const height = hero.height * layers.scale;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<defs>${gradients(width, height)}</defs>`,
    `<rect width="${width}" height="${height}" fill="#0e0f13"/>`,
    `<rect width="${width}" height="${height}" fill="url(#glow)"/>`,
    `<rect width="${width}" height="${height}" fill="url(#vignette)"/>`,
    `</svg>`,
  ].join("");
}

function gradients(width: number, height: number): string {
  return [
    `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="${width / 2}" cy="${height * 0.32}" r="${width * 0.56}">`,
    `<stop offset="0" stop-color="#818cf8" stop-opacity="0.20"/>`,
    `<stop offset="0.55" stop-color="#6d5bd0" stop-opacity="0.07"/>`,
    `<stop offset="1" stop-color="#818cf8" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="${width / 2}" cy="${height / 2}" r="${width * 0.7}">`,
    `<stop offset="0.4" stop-color="#000000" stop-opacity="0"/>`,
    `<stop offset="1" stop-color="#000000" stop-opacity="0.5"/>`,
    `</radialGradient>`,
  ].join("");
}

function layout(): Record<Id, Placed> {
  const { overlap } = hero;
  const span =
    inputs.tui.width +
    inputs.browser.width +
    inputs.telegram.width -
    overlap.tui -
    overlap.telegram;
  const left = (hero.width - span) / 2;
  const browserX = left + inputs.tui.width - overlap.tui;
  const rest = (id: Id, x: number) => {
    const { height: tall } = place(id, inputs[id].width, x, 0);
    return place(id, inputs[id].width, x, hero.baseline - tall);
  };
  return {
    browser: place("browser", inputs.browser.width, browserX, hero.top),
    tui: rest("tui", left),
    telegram: rest(
      "telegram",
      browserX + inputs.browser.width - overlap.telegram
    ),
  };
}

const positions = layout();

function composite(): string {
  const { width, height } = hero;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    gradients(width, height),
    ...order.map((id) => positions[id].defs),
    ...order.map((id) =>
      Frame.shadow(
        `shadow-${id}`,
        1,
        elevation[id].depth,
        elevation[id].opacity
      )
    ),
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="#0e0f13"/>`,
    `<rect width="${width}" height="${height}" fill="url(#glow)"/>`,
    `<rect width="${width}" height="${height}" fill="url(#vignette)"/>`,
    ...order.map(
      (id) => `<g filter="url(#shadow-${id})">${positions[id].body}</g>`
    ),
    `</svg>`,
  ].join("");
}

function placement(): string {
  const at = (id: Id) => ({
    x: Math.round((positions[id].x - layers.pad) * layers.scale),
    y: Math.round((positions[id].y - layers.pad) * layers.scale),
  });
  return `${JSON.stringify(
    {
      canvas: {
        width: hero.width * layers.scale,
        height: hero.height * layers.scale,
      },
      order,
      layers: Object.fromEntries(order.map((id) => [id, at(id)])),
    },
    undefined,
    2
  )}\n`;
}

await Promise.all([
  Bun.write(new URL("hero.webp", assets), await webp(composite())),
  Bun.write(
    new URL(`${layers.dir}background.png`, assets),
    raster(backdrop()).asPng()
  ),
  Bun.write(new URL(`${layers.dir}placement.json`, assets), placement()),
  ...order.map((id) =>
    Bun.write(
      new URL(`${layers.dir}${id}.png`, assets),
      raster(layer(id)).asPng()
    )
  ),
]);
