const palette = {
  bar: "#3a4047",
  glyph: "#8b9096",
  title: "#c3cad1",
  pill: "#23282e",
  pillText: "#aab2b9",
  backdrop: "#1b1d22",
  edge: "#ffffff",
} as const;

export type Source = {
  readonly data: string;
  readonly width: number;
  readonly height: number;
};

export type Chrome = {
  readonly title: string;
  readonly address?: string;
};

export type Window = {
  readonly id: string;
  readonly source: Source;
  readonly chrome: Chrome;
  readonly width: number;
  readonly unit: number;
};

export type Placed = {
  readonly defs: string;
  readonly body: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function n(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
}

function buttons(x: number, y: number, width: number, unit: number): string {
  const cy = y + 24 * unit;
  const at = (offset: number) => x + width - offset * unit;
  const [minimise, maximise, close] = [at(197), at(118), at(39)];
  const arm = 10.5 * unit;
  return [
    `<rect x="${n(minimise - 11.5 * unit)}" y="${n(y + 31 * unit)}" width="${n(23 * unit)}" height="${n(3 * unit)}" fill="${palette.glyph}"/>`,
    `<rect x="${n(maximise - 12.5 * unit)}" y="${n(y + 13 * unit)}" width="${n(25 * unit)}" height="${n(23 * unit)}" fill="none" stroke="${palette.glyph}" stroke-width="${n(2 * unit)}"/>`,
    `<g stroke="${palette.glyph}" stroke-width="${n(2 * unit)}" stroke-linecap="round">`,
    `<line x1="${n(close - arm)}" y1="${n(cy - arm)}" x2="${n(close + arm)}" y2="${n(cy + arm)}"/>`,
    `<line x1="${n(close - arm)}" y1="${n(cy + arm)}" x2="${n(close + arm)}" y2="${n(cy - arm)}"/>`,
    `</g>`,
  ].join("");
}

function text(
  x: number,
  y: number,
  unit: number,
  anchor: "start" | "middle",
  fill: string,
  body: string
): string {
  return `<text x="${n(x)}" y="${n(y + 31 * unit)}" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="${n(17 * unit)}" font-weight="500" fill="${fill}" text-anchor="${anchor}">${escape(body)}</text>`;
}

function address(
  x: number,
  y: number,
  width: number,
  unit: number,
  bar: number,
  label: string
): string {
  const height = 32 * unit;
  const pill = Math.min(Math.max(width * 0.38, 300 * unit), 560 * unit);
  return [
    `<rect x="${n(x + (width - pill) / 2)}" y="${n(y + (bar - height) / 2)}" width="${n(pill)}" height="${n(height)}" rx="${n(height / 2)}" fill="${palette.pill}"/>`,
    text(x + width / 2, y, unit, "middle", palette.pillText, label),
  ].join("");
}

function titlebar(window: Window, x: number, y: number): string {
  const { unit, width, chrome } = window;
  const bar = 51 * unit;
  return [
    `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(bar)}" fill="${palette.bar}"/>`,
    text(x + 24 * unit, y, unit, "start", palette.title, chrome.title),
    chrome.address === undefined
      ? ""
      : address(x, y, width, unit, bar, chrome.address),
    buttons(x, y, width, unit),
  ].join("");
}

function place(window: Window, x: number, y: number): Placed {
  const { source, width, unit, id } = window;
  const bar = 51 * unit;
  const scale = width / source.width;
  const height = bar + source.height * scale;
  const radius = 11 * unit;
  const inset = Math.max(1, 1.2 * unit);
  const defs = `<clipPath id="clip-${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="${n(radius)}"/></clipPath>`;
  const body = [
    `<g clip-path="url(#clip-${id})">`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="${palette.backdrop}"/>`,
    `<image href="data:image/png;base64,${source.data}" x="${n(x)}" y="${n(y + bar)}" width="${n(width)}" height="${n(source.height * scale)}" preserveAspectRatio="none"/>`,
    titlebar(window, x, y),
    `</g>`,
    `<rect x="${n(x + inset / 2)}" y="${n(y + inset / 2)}" width="${n(width - inset)}" height="${n(height - inset)}" rx="${n(radius)}" fill="none" stroke="${palette.edge}" stroke-opacity="0.08" stroke-width="${n(inset)}"/>`,
  ].join("");
  return { defs, body, x, y, width, height };
}

function shadow(
  id: string,
  unit: number,
  depth: number,
  opacity: number
): string {
  return `<filter id="${id}" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="${n(depth * 0.6 * unit)}" stdDeviation="${n(depth * unit)}" flood-color="#05060a" flood-opacity="${opacity}"/></filter>`;
}

export const Frame = { place, shadow, palette };
