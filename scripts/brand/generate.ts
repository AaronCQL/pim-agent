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

await Promise.all([
  Bun.write(new URL("wordmark.svg", destination), wordmark.svg),
  Bun.write(new URL("favicon.svg", destination), favicon.svg),
  Bun.write(
    new URL("apple-touch-icon.png", destination),
    new Resvg(touchIcon.svg, { fitTo: { mode: "width", value: 180 } })
      .render()
      .asPng()
  ),
]);
