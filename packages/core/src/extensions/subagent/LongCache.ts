import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;

function supports(model: Model): boolean {
  const compat = model.compat as
    | { readonly supportsLongCacheRetention?: boolean }
    | undefined;
  return (
    model.api === "anthropic-messages" &&
    compat?.supportsLongCacheRetention !== false
  );
}

/** Every `cache_control` with a one-hour `ttl`. Copy-on-write: only the paths down to one are copied. */
function extend(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    const items = payload.map(extend);
    return items.some((item, i) => item !== payload[i]) ? items : payload;
  }
  if (typeof payload !== "object" || payload === null) {
    return payload;
  }
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(payload)) {
    const next =
      key === "cache_control" && typeof value === "object" && value !== null
        ? { ...value, ttl: "1h" }
        : extend(value);
    if (next !== value) {
      copy ??= { ...payload };
      copy[key] = next;
    }
  }
  return copy ?? payload;
}

export const LongCache = { supports, extend };
