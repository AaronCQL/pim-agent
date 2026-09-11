import { Resvg } from "@resvg/resvg-js";
import { iconBackground, style } from "./config";
import { Logo } from "./Logo";

const destination = new URL("../../assets/brand/", import.meta.url);
const wordmark = Logo.render(style);
const favicon = Logo.render(style, {
  favicon: true,
  background: iconBackground,
});
const touchIcon = Logo.render(style, {
  mark: true,
  background: iconBackground,
});
// An Android launcher masks the icon to its own shape, so the maskable copy
// spends a second cell of padding keeping the P inside the safe circle.
const maskableIcon = Logo.render(
  { ...style, padding: 2 },
  { mark: true, background: iconBackground }
);

function png(svg: string, size: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } })
    .render()
    .asPng();
}

await Promise.all([
  Bun.write(new URL("wordmark.svg", destination), wordmark.svg),
  Bun.write(new URL("favicon.svg", destination), favicon.svg),
  Bun.write(
    new URL("apple-touch-icon.png", destination),
    png(touchIcon.svg, 180)
  ),
  Bun.write(new URL("icon-192.png", destination), png(touchIcon.svg, 192)),
  Bun.write(new URL("icon-512.png", destination), png(touchIcon.svg, 512)),
  Bun.write(
    new URL("icon-maskable.png", destination),
    png(maskableIcon.svg, 512)
  ),
]);
