/**
 * Twice the width a sidebar row can show, so a name is never silently cut at the
 * length it happens to render at, and a pasted essay still cannot become one.
 */
const LIMIT = 80;

/** What pi should store for this name: whitespace collapsed, controls gone, `""` to clear. */
function normalise(name: string | null | undefined): string {
  const clean = (name ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // By code point: a cap that splits a surrogate pair stores half a character.
  return [...clean].slice(0, LIMIT).join("").trim();
}

/** The one spelling of a session name pim writes into pi's `session_info`. */
export const SessionName = { LIMIT, normalise };
