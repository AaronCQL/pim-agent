import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Import first: Solid and micromark read `document` at load time.
// Keep native network globals: happy-dom's `AbortSignal` breaks native `fetch`.
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
