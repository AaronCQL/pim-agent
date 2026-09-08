const MATCHERS: ReadonlyArray<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
];

/** Locate `pattern` in `lines` at or after `start`, relaxing whitespace over three passes; `eof` searches flush against the end. */
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

  for (const eq of MATCHERS) {
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
