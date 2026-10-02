/** In code points. */
const LIMIT = 80;

/** Collapses whitespace and strips control characters; `""` clears the name. */
function normalise(name: string | null | undefined): string {
  const clean = (name ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // Slice by code point so a surrogate pair is never split.
  return [...clean].slice(0, LIMIT).join("").trim();
}

export const SessionName = { normalise };
