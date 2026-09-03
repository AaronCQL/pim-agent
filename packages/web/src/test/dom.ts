import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Import this *first* in any web test: Solid's DOM runtime — and, under the
 * browser condition, micromark's entity decoder — reach for a global
 * `document`, and ES modules evaluate in declaration order, so a leading
 * side-effect import is what puts one there in time.
 *
 * Per file rather than from `bunfig.toml` because the registrator is a whole
 * environment, not a shim; `test:web` runs with `--isolate`, so the globals
 * never outlive the file that asked for them.
 *
 * The network globals are put back afterwards. The registrator's own are a
 * browser's — same-origin policy included, and a `Response` `Bun.serve`
 * refuses — and a test that drives the real gateway is not a browser talking
 * to a foreign origin, it is this process talking to itself.
 *
 * `AbortController`/`AbortSignal` belong to that set even though they carry no
 * bytes: the native `fetch` type-checks `signal` by identity, so a happy-dom
 * signal reaching it fails the call outright. Pi cancels every provider request
 * with one, so leaving them registered turns each model call into a retried
 * "Connection error." instead of a request.
 */
const NETWORK_GLOBALS = [
  "fetch",
  "WebSocket",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
] as const;

if (!("document" in globalThis)) {
  const native = Object.fromEntries(
    NETWORK_GLOBALS.map((name) => [name, globalThis[name]])
  );
  GlobalRegistrator.register();
  Object.assign(globalThis, native);
}

export function mountPoint(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}
