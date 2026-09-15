/** One indexable word and where it sits in the string it came from. */
export type SearchToken = {
  /** Lowercased: the corpus itself is never lowered, only its tokens. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

const RUN = /[\p{L}\p{N}_]+/gu;

function scan(text: string): readonly SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const run of text.matchAll(RUN)) {
    const at = run.index;
    const word = run[0];
    const pieces = piecesOf(word);
    for (const [from, to] of pieces) {
      tokens.push({
        text: word.slice(from, to).toLowerCase(),
        start: at + from,
        end: at + to,
      });
    }
    if (pieces.length > 1) {
      tokens.push({
        text: word.toLowerCase(),
        start: at,
        end: at + word.length,
      });
    }
  }
  return tokens;
}

/**
 * The words a query asks for: its pieces alone, never the identifier they
 * spell. `SessionLease` asks for `session` and `lease`, which the index holds
 * for `SessionLease` and for `session lease` alike; asking for `sessionlease`
 * too would AND away the second.
 */
function words(query: string): readonly string[] {
  const found: string[] = [];
  for (const run of query.matchAll(RUN)) {
    for (const [from, to] of piecesOf(run[0])) {
      const word = run[0].slice(from, to).toLowerCase();
      if (!found.includes(word)) {
        found.push(word);
      }
    }
  }
  return found;
}

/** Half-open slices of one run: `WsGateway` is `ws` and `gateway`, `read_file` is `read` and `file`. */
function piecesOf(run: string): readonly (readonly [number, number])[] {
  const pieces: (readonly [number, number])[] = [];
  let start = -1;
  for (let at = 0; at < run.length; at++) {
    if (run[at] === "_") {
      if (start >= 0) {
        pieces.push([start, at]);
        start = -1;
      }
      continue;
    }
    if (start < 0) {
      start = at;
    } else if (breaksAt(run, at)) {
      pieces.push([start, at]);
      start = at;
    }
  }
  if (start >= 0) {
    pieces.push([start, run.length]);
  }
  return pieces;
}

function breaksAt(run: string, at: number): boolean {
  const here = run[at]!;
  if (!isUpper(here)) {
    return false;
  }
  const before = run[at - 1]!;
  const after = run[at + 1];
  return !isUpper(before) || (after !== undefined && isLower(after));
}

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function isLower(char: string): boolean {
  return char !== char.toUpperCase() && char === char.toLowerCase();
}

export const SearchTokens = { scan, words };
