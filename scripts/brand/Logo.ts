import type { LogoStyle } from "./config";

type Options = {
  readonly mark?: boolean;
  readonly favicon?: boolean;
  readonly background?: string;
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    }[char]!;
  });
}

function validate(style: LogoStyle): void {
  for (const key of ["pixel", "gap", "radius", "spacing", "padding"] as const) {
    if (!Number.isFinite(style[key]) || style[key] < 0) {
      throw new Error(`${key} must be finite and nonnegative`);
    }
  }
  if (
    style.pixel === 0 ||
    style.gap >= 1 ||
    style.radius > (1 - style.gap) / 2
  ) {
    throw new Error(
      "Pixels need positive size, gap < 1, and radius <= half a tile"
    );
  }
  if (style.glyphs.length !== 3) {
    throw new Error("Supply one glyph for each of P, I, M");
  }
  const height = style.glyphs[0]?.length;
  for (const rows of style.glyphs) {
    const width = rows[0]?.length;
    if (
      !height ||
      !width ||
      rows.length !== height ||
      !rows.some((row) => row.includes("1"))
    ) {
      throw new Error("Glyphs must be nonempty and share a height");
    }
    if (rows.some((row) => row.length !== width || !/^[01]+$/.test(row))) {
      throw new Error("Glyphs must be rectangular grids of 0 and 1");
    }
  }
}

function render(style: LogoStyle, options: Options = {}) {
  validate(style);
  const mark = options.mark || options.favicon;
  const glyphs = mark ? style.glyphs.slice(0, 1) : style.glyphs;
  const pixel = options.favicon ? 2 : style.pixel;
  const gap = options.favicon ? 0 : style.gap * pixel;
  const radius = options.favicon ? 0 : style.radius * pixel;
  const inkWidth =
    glyphs.reduce((sum, rows) => sum + rows[0]!.length, 0) * pixel +
    (glyphs.length - 1) * style.spacing * pixel;
  const inkHeight = glyphs[0]!.length * pixel;
  const padding = style.padding * pixel;
  const width = options.favicon
    ? 16
    : (mark ? Math.max(inkWidth, inkHeight) : inkWidth) + 2 * padding;
  const height = options.favicon
    ? 16
    : (mark ? Math.max(inkWidth, inkHeight) : inkHeight) + 2 * padding;
  if (inkWidth > width || inkHeight > height) {
    throw new Error("P must fit the 16px favicon at 2px per cell");
  }
  const xOrigin = options.favicon
    ? Math.floor((width - inkWidth) / 2)
    : (width - inkWidth) / 2;
  const yOrigin = options.favicon
    ? Math.floor((height - inkHeight) / 2)
    : (height - inkHeight) / 2;
  const shapes: string[] = [];
  if (options.background !== undefined) {
    shapes.push(
      `<rect width="${width}" height="${height}" fill="${escape(options.background)}"/>`
    );
  }
  const cells: string[] = [];
  let x = xOrigin;
  glyphs.forEach((rows) => {
    rows.forEach((row, y) => {
      [...row].forEach((cell, column) => {
        if (cell === "1") {
          cells.push(
            `<rect x="${x + column * pixel + gap / 2}" y="${yOrigin + y * pixel + gap / 2}" width="${pixel - gap}" height="${pixel - gap}" rx="${radius}"/>`
          );
        }
      });
    });
    x += (rows[0]!.length + style.spacing) * pixel;
  });
  shapes.push(`<g fill="${escape(style.color)}">${cells.join("")}</g>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${mark ? "PIM icon" : "PIM"}</title>${shapes.join("")}</svg>\n`;
  return { svg, width, height };
}

export const Logo = { render };
