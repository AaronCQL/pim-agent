import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Import this first: Solid and micromark reach for a global `document` as they evaluate.
// Keep the native network globals: happy-dom's `AbortSignal` fails native `fetch`'s identity check.
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
