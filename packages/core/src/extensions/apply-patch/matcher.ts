/**
 * Faithful port of Codex's `seek_sequence`. Locates `pattern` within `lines`
 * at or after `start`, advancing strictness in three passes: exact, then
 * ignore trailing whitespace, then ignore leading + trailing whitespace.
 * When `eof` is true the search begins at the position where the pattern
 * would land flush against the end of the file.
 *
 * Special cases (matching Codex):
 *  - empty `pattern` -> returns `start` (no-op match).
 *  - `pattern.length > lines.length` -> returns `undefined`.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean
): number | undefined {
  return seekSequenceMatches(lines, pattern, start, eof)[0];
}

export function seekSequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean
): readonly number[] {
  if (pattern.length === 0) {
    return [start];
  }
  if (pattern.length > lines.length) {
    return [];
  }

  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;
  const last = lines.length - pattern.length;

  const matchers: ReadonlyArray<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];

  for (const eq of matchers) {
    const matches: number[] = [];
    for (let i = searchStart; i <= last; i += 1) {
      let ok = true;
      for (let p = 0; p < pattern.length; p += 1) {
        if (!eq(lines[i + p]!, pattern[p]!)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matches.push(i);
      }
    }
    if (matches.length > 0) {
      return matches;
    }
  }

  return [];
}
