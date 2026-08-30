import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Import this *first* in any web test: Solid's DOM runtime — and, under the
 * browser condition, micromark's entity decoder — reach for a global
 * `document`, and ES modules evaluate in declaration order, so a leading
 * side-effect import is what puts one there in time.
 *
 * Per file rather than from `bunfig.toml` because the registrator also swaps
 * `fetch` and `WebSocket`, which the gateway tests need real. `test:web` runs
 * with `--isolate`, so the globals never outlive the file that asked for them.
 */
if (!("document" in globalThis)) {
  GlobalRegistrator.register();
}

export function mountPoint(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}
