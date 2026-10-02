import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { Attachments } from "../attachments/Attachments";
import { Levenshtein } from "../shared/Levenshtein";
import { Pool } from "../shared/Pool";
import { MessageText } from "./MessageText";
import { SearchTokens, type SearchToken } from "./SearchTokens";
import {
  NEWLINE,
  SessionDigest,
  type DigestParts,
  type Durable,
} from "./SessionDigest";
import type { SessionSummary } from "./SessionRegistry";

/** Half-open character offsets; non-overlapping and ascending. */
export type SearchRange = readonly [start: number, end: number];

export type SearchSnippet = {
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Offsets into `text`, not into the message. */
  readonly ranges: readonly SearchRange[];
  /** The snippet does not start at the message start. */
  readonly cutHead?: true;
};

export type SearchHit = {
  readonly sessionId: string;
  readonly cwd: string;
  /** Local file path; do not send over the wire. */
  readonly path: string;
  readonly title?: string;
  readonly named?: true;
  /** Offsets into the clamped `title`. */
  readonly titleRanges: readonly SearchRange[];
  /** The first user message; set only for named sessions. */
  readonly opening?: string;
  /** End of the last completed turn, else the session's creation time. */
  readonly settledAt: number;
  readonly snippets: readonly SearchSnippet[];
  /** Matching messages in this session, before the snippet cut. */
  readonly total: number;
  /** Matched only via typo expansion; ranks below exact hits. */
  readonly typos: boolean;
};

export type SearchAnswer = {
  readonly hits: readonly SearchHit[];
  /** Query words dropped to get any results, rarest first. */
  readonly dropped: readonly string[];
  readonly scanned: number;
};

export type SearchOptions = {
  readonly limit?: number;
  readonly cwd?: string;
  /** Applied before `limit`. */
  readonly accept?: (sessionId: string) => boolean;
};

export type SearchIndexDeps = {
  readonly list: () => Promise<readonly SessionSummary[]>;
  /** Clock for the refresh throttle. */
  readonly now?: () => number;
};

type Role = "user" | "assistant";

type Turn = {
  readonly seq: number;
  readonly role: Role;
  readonly text: string;
};

type Entry = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: number;
  modifiedAt: number;
  /** Bytes read so far; the next tail read starts here. */
  offset: number;
  /** Lines read so far. */
  seq: number;
  parts: DigestParts;
  digest: SessionDigest;
  readonly turns: Turn[];
};

type Posting = {
  readonly entry: Entry;
  readonly turn: Turn;
};

/** `full` replaces the entry; otherwise `body` is appended to it. */
type Read = {
  readonly full: boolean;
  readonly body?: Durable;
};

type Taken = {
  readonly entry: Entry;
  /** Turn count before this read; later turns are new. */
  readonly from: number;
  /** An existing entry was re-read in full, so postings must be rebuilt. */
  readonly replaced: boolean;
};

type Plan = {
  /** The word itself, plus completions when it is the last word. */
  readonly exact: readonly string[];
  readonly typo: readonly string[];
};

type Group = {
  readonly turns: Turn[];
  title: boolean;
  exact: boolean;
};

/** Rank inputs, computed without tokenising any message. */
type Ranked = {
  readonly entry: Entry;
  readonly group: Group;
  readonly terms: ReadonlySet<string>;
  readonly typos: boolean;
  readonly field: number;
  readonly settledAt: number;
};

const FILE_READS = 16;

const REFRESH_MS = 500;

/** Typesense's `typo_tokens_threshold`: typos are tried only below this many results. */
const ENOUGH = 1;

/** Typesense's `max_candidates`. */
const MAX_CANDIDATES = 4;

const MAX_TYPOS = 2;

/** Typesense's `highlight_affix_num_tokens`: tokens shown before the first match. */
const AFFIX = 4;

/** Snippet length in characters; more than the widest row shows, so the client's ellipsis cuts it. */
const TAIL = 100;

const SNIPPETS = 2;

const PREVIEW = 200;

const LIMIT = 20;

/** Lines without this are skipped before decoding. */
const TEXT = Buffer.from('"text"');

/**
 * Inverted index over user and assistant text in every session, plus titles.
 * Built on the first query and refreshed incrementally by later ones.
 */
export class SearchIndex {
  private readonly list: () => Promise<readonly SessionSummary[]>;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly postings = new Map<string, number[]>();
  private readonly titles = new Map<string, Entry[]>();
  private turns: Posting[] = [];
  private vocabulary: readonly string[] = [];
  private vocabularyStale = true;
  private built?: Promise<void>;
  private syncing?: Promise<void>;
  private syncedAt = 0;

  public constructor(deps: SearchIndexDeps) {
    this.list = deps.list;
    this.now = deps.now ?? Date.now;
  }

  /** Memoised: concurrent callers share one build. */
  public ready(): Promise<void> {
    this.built ??= this.sync().catch((error: unknown) => {
      this.built = undefined;
      throw error;
    });
    return this.built;
  }

  public async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchAnswer> {
    await this.ready();
    await this.refresh();

    const scope = this.scope(options);
    const dropped: string[] = [];
    let kept = SearchTokens.words(query);
    let ranked = kept.length === 0 ? [] : this.run(kept, scope);
    while (ranked.length < ENOUGH && kept.length > 1) {
      const rarest = this.rarest(kept);
      dropped.push(kept[rarest]!);
      kept = kept.filter((_, index) => index !== rarest);
      ranked = this.run(kept, scope);
    }

    return {
      hits: ranked
        .sort(byRank)
        .slice(0, options.limit ?? LIMIT)
        .map(hitOf),
      dropped,
      scanned: scope.size,
    };
  }

  /** Exact and prefix first; adds typos only while results are too few. */
  private run(words: readonly string[], scope: ReadonlySet<Entry>): Ranked[] {
    const reach = Math.min(MAX_TYPOS, Math.max(...words.map(gateOf)));
    const last = words.length - 1;
    let ranked: Ranked[] = [];
    for (let typos = 0; typos <= reach; typos++) {
      const plans = words.map((word, at) =>
        this.plan(word, at === last, typos)
      );
      ranked = this.collect(plans, scope);
      if (ranked.length >= ENOUGH) {
        break;
      }
    }
    return ranked;
  }

  private plan(word: string, last: boolean, typos: number): Plan {
    const exact = this.known(word) ? [word] : [];
    if (last) {
      const prefixes = this.vocabularyOf().filter(
        (term) => term !== word && term.startsWith(word)
      );
      exact.push(...this.best(prefixes));
    }

    const allowed = Math.min(typos, gateOf(word));
    if (allowed === 0) {
      return { exact, typo: [] };
    }
    const reached = new Set(exact);
    const near = this.vocabularyOf()
      .filter((term) => !reached.has(term))
      .map((term) => ({
        term,
        distance: Levenshtein.damerau(word, term, allowed),
      }))
      .filter((candidate) => candidate.distance <= allowed)
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          this.frequencyOf(b.term) - this.frequencyOf(a.term) ||
          a.term.localeCompare(b.term)
      );
    return {
      exact,
      typo: near.slice(0, MAX_CANDIDATES).map((candidate) => candidate.term),
    };
  }

  private collect(plans: readonly Plan[], scope: ReadonlySet<Entry>): Ranked[] {
    const turnsExact = plans.map((plan) => union(this.postings, plan.exact));
    const titlesExact = plans.map((plan) => union(this.titles, plan.exact));
    const everything = plans.map((plan) => [...plan.exact, ...plan.typo]);
    const turns = everything.map((terms) => union(this.postings, terms));
    const titles = everything.map((terms) => union(this.titles, terms));
    const terms = new Set(everything.flat());

    const groups = new Map<Entry, Group>();
    for (const ordinal of intersect(turns)) {
      const posting = this.turns[ordinal]!;
      if (!scope.has(posting.entry)) {
        continue;
      }
      const group = groupIn(groups, posting.entry);
      group.turns.push(posting.turn);
      group.exact ||= turnsExact.every((found) => found.has(ordinal));
    }
    for (const entry of intersect(titles)) {
      if (!scope.has(entry)) {
        continue;
      }
      const group = groupIn(groups, entry);
      group.title = true;
      group.exact ||= titlesExact.every((found) => found.has(entry));
    }

    return [...groups].map(([entry, group]) => rankedOf(entry, group, terms));
  }

  private scope(options: SearchOptions): ReadonlySet<Entry> {
    const scoped = new Set<Entry>();
    for (const entry of this.entries.values()) {
      const wanted =
        (options.cwd === undefined || entry.cwd === options.cwd) &&
        (options.accept === undefined || options.accept(entry.sessionId));
      if (wanted) {
        scoped.add(entry);
      }
    }
    return scoped;
  }

  /** "Words that have the least individual results are dropped first." */
  private rarest(words: readonly string[]): number {
    let rarest = 0;
    for (const [at, word] of words.entries()) {
      if (this.frequencyOf(word) < this.frequencyOf(words[rarest]!)) {
        rarest = at;
      }
    }
    return rarest;
  }

  private frequencyOf(term: string): number {
    return (
      (this.postings.get(term)?.length ?? 0) +
      (this.titles.get(term)?.length ?? 0)
    );
  }

  private known(term: string): boolean {
    return this.postings.has(term) || this.titles.has(term);
  }

  private best(terms: readonly string[]): readonly string[] {
    return [...terms]
      .sort(
        (a, b) =>
          this.frequencyOf(b) - this.frequencyOf(a) || a.localeCompare(b)
      )
      .slice(0, MAX_CANDIDATES);
  }

  private vocabularyOf(): readonly string[] {
    if (this.vocabularyStale) {
      this.vocabulary = [
        ...new Set([...this.postings.keys(), ...this.titles.keys()]),
      ];
      this.vocabularyStale = false;
    }
    return this.vocabulary;
  }

  private async refresh(): Promise<void> {
    if (this.now() - this.syncedAt < REFRESH_MS) {
      return;
    }
    this.syncing ??= this.sync().finally(() => {
      this.syncing = undefined;
    });
    await this.syncing;
  }

  private async sync(): Promise<void> {
    const summaries = await this.list();
    const taken = await Pool.mapPooled(summaries, FILE_READS, (summary) =>
      this.take(summary)
    );

    const alive = new Set(summaries.map((summary) => summary.sessionId));
    const appended: { readonly entry: Entry; readonly from: number }[] = [];
    let replaced = false;
    for (const one of taken) {
      if (one === undefined) {
        continue;
      }
      replaced ||= one.replaced;
      this.entries.set(one.entry.sessionId, one.entry);
      appended.push({ entry: one.entry, from: one.from });
    }

    for (const sessionId of this.entries.keys()) {
      if (!alive.has(sessionId)) {
        this.entries.delete(sessionId);
        replaced = true;
      }
    }

    // Postings are indices into `turns`, so a replaced or removed session forces a full reindex.
    if (replaced) {
      this.reindex();
    } else {
      for (const { entry, from } of appended) {
        this.post(entry, entry.turns.slice(from));
      }
    }
    this.retitle();
    this.vocabularyStale = true;
    this.syncedAt = this.now();
  }

  /** Absorbs the file's bytes immediately so they are not all held at once. */
  private async take(summary: SessionSummary): Promise<Taken | undefined> {
    const read = await this.read(summary);
    if (read === undefined) {
      return undefined;
    }
    const known = this.entries.get(summary.sessionId);
    const entry = read.full ? blank(summary) : known!;
    const from = entry.turns.length;
    entry.modifiedAt = summary.modifiedAt;
    if (read.body !== undefined) {
      absorb(entry, read.body);
    }
    return { entry, from, replaced: read.full && known !== undefined };
  }

  /** Reads only the appended tail, unless the file shrank or its mtime went backwards. */
  private async read(summary: SessionSummary): Promise<Read | undefined> {
    const known = this.entries.get(summary.sessionId);
    const file = Bun.file(summary.path);
    try {
      if (known === undefined) {
        return { full: true, body: SessionDigest.durable(await file.bytes()) };
      }
      if (summary.modifiedAt === known.modifiedAt) {
        return undefined;
      }
      const shrank = (await file.stat()).size < known.offset;
      if (shrank || summary.modifiedAt < known.modifiedAt) {
        return { full: true, body: SessionDigest.durable(await file.bytes()) };
      }
      const tail = await file.slice(known.offset).bytes();
      return { full: false, body: SessionDigest.durable(tail) };
    } catch {
      return undefined;
    }
  }

  private post(entry: Entry, turns: readonly Turn[]): void {
    for (const turn of turns) {
      const ordinal = this.turns.length;
      this.turns.push({ entry, turn });
      for (const token of tokensOf(turn.text)) {
        add(this.postings, token, ordinal);
      }
    }
  }

  private reindex(): void {
    this.turns = [];
    this.postings.clear();
    for (const entry of this.entries.values()) {
      this.post(entry, entry.turns);
    }
  }

  private retitle(): void {
    this.titles.clear();
    for (const entry of this.entries.values()) {
      const title = entry.digest.title;
      if (title === undefined) {
        continue;
      }
      for (const token of tokensOf(title)) {
        add(this.titles, token, entry);
      }
    }
  }
}

function blank(summary: SessionSummary): Entry {
  return {
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    path: summary.path,
    createdAt: summary.createdAt,
    modifiedAt: summary.modifiedAt,
    offset: 0,
    seq: 0,
    parts: {},
    digest: {},
    turns: [],
  };
}

function absorb(entry: Entry, body: Durable): void {
  const read = spokenIn(body, entry.seq);
  entry.turns.push(...read.turns);
  entry.seq += read.lines;
  entry.offset += body.end;
  entry.parts = SessionDigest.merge(entry.parts, SessionDigest.partsOf(body));
  entry.digest = SessionDigest.of(entry.parts);
}

function spokenIn(
  body: Durable,
  from: number
): { readonly turns: readonly Turn[]; readonly lines: number } {
  const { bytes, end } = body;
  const turns: Turn[] = [];
  let marker = bytes.indexOf(TEXT);
  let at = 0;
  let lines = 0;
  while (at < end) {
    const to = bytes.indexOf(NEWLINE, at);
    lines += 1;
    if (marker !== -1 && marker < at) {
      marker = bytes.indexOf(TEXT, at);
    }
    if (marker !== -1 && marker < to) {
      const turn = turnOf(bytes.toString("utf8", at, to), from + lines);
      if (turn !== undefined) {
        turns.push(turn);
      }
    }
    at = to + 1;
  }
  return { turns, lines };
}

function turnOf(line: string, seq: number): Turn | undefined {
  const entry = parseSessionEntries(line)[0];
  if (entry?.type !== "message") {
    return undefined;
  }
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  const said = MessageText.textOf(message.content);
  const text = (
    message.role === "user" ? Attachments.parse(said).text : said
  ).trim();
  return text === "" ? undefined : { seq, role: message.role, text };
}

function rankedOf(
  entry: Entry,
  group: Group,
  terms: ReadonlySet<string>
): Ranked {
  const { title, settledAt } = entry.digest;
  return {
    entry,
    group,
    terms,
    typos: !group.exact,
    field: fieldOf(group, title),
    settledAt: settledAt ?? entry.createdAt,
  };
}

function hitOf(ranked: Ranked): SearchHit {
  const { entry, group, terms } = ranked;
  const { title, named } = entry.digest;
  const spoken = [...group.turns].sort(byRecognition);
  const opening = entry.parts.opening;
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    path: entry.path,
    ...(title === undefined ? {} : { title }),
    ...(named === undefined ? {} : { named }),
    ...(named === true && opening !== undefined
      ? { opening: opening.slice(0, PREVIEW) }
      : {}),
    settledAt: ranked.settledAt,
    titleRanges:
      group.title && title !== undefined ? rangesOf(title, terms) : [],
    snippets: spoken.slice(0, SNIPPETS).map((turn) => snippetOf(turn, terms)),
    total: group.turns.length,
    typos: ranked.typos,
  };
}

function snippetOf(turn: Turn, terms: ReadonlySet<string>): SearchSnippet {
  const tokens = [...SearchTokens.scan(turn.text)].sort(
    (a, b) => a.start - b.start || b.end - a.end
  );
  const at = tokens.findIndex((token) => terms.has(token.text));
  const head = at - AFFIX;
  const from = head <= 0 ? 0 : tokens[head]!.start;
  const to = Math.min(turn.text.length, from + TAIL);
  return {
    seq: turn.seq,
    role: turn.role,
    text: turn.text.slice(from, to),
    ranges: rangesIn(tokens, terms, from, to),
    ...(from > 0 ? { cutHead: true as const } : {}),
  };
}

function rangesOf(
  text: string,
  terms: ReadonlySet<string>
): readonly SearchRange[] {
  return rangesIn(SearchTokens.scan(text), terms, 0, text.length);
}

/** Ranges within `[from, to)`, relative to `from`. */
function rangesIn(
  tokens: readonly SearchToken[],
  terms: ReadonlySet<string>,
  from: number,
  to: number
): readonly SearchRange[] {
  return merge(
    tokens
      .filter(
        (token) =>
          terms.has(token.text) && token.start >= from && token.end <= to
      )
      .map((token) => [token.start - from, token.end - from] as SearchRange)
  );
}

function merge(ranges: readonly SearchRange[]): readonly SearchRange[] {
  const marked: SearchRange[] = [];
  for (const [start, end] of [...ranges].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1]
  )) {
    const last = marked.at(-1);
    if (last !== undefined && start <= last[1]) {
      marked[marked.length - 1] = [last[0], Math.max(last[1], end)];
    } else {
      marked.push([start, end]);
    }
  }
  return marked;
}

/** User turns first, then by seq. */
function byRecognition(a: Turn, b: Turn): number {
  return a.role === b.role ? a.seq - b.seq : a.role === "user" ? -1 : 1;
}

/** The first turn by `byRecognition`, without sorting. */
function leadOf(turns: readonly Turn[]): Turn | undefined {
  let lead: Turn | undefined;
  for (const turn of turns) {
    if (lead === undefined || byRecognition(turn, lead) < 0) {
      lead = turn;
    }
  }
  return lead;
}

function byRank(a: Ranked, b: Ranked): number {
  if (a.typos !== b.typos) {
    return a.typos ? 1 : -1;
  }
  return a.field - b.field || b.settledAt - a.settledAt;
}

/** Title match, then user turn, then assistant turn. */
function fieldOf(group: Group, title: string | undefined): number {
  if (group.title && title !== undefined) {
    return 0;
  }
  return leadOf(group.turns)?.role === "user" ? 1 : 2;
}

/** Typesense's `min_len_1typo` and `min_len_2typo`. */
function gateOf(word: string): number {
  if (word.length < 4) {
    return 0;
  }
  return word.length < 7 ? 1 : 2;
}

function tokensOf(text: string): ReadonlySet<string> {
  return new Set(SearchTokens.scan(text).map((token) => token.text));
}

function add<T>(into: Map<string, T[]>, key: string, value: T): void {
  const found = into.get(key);
  if (found === undefined) {
    into.set(key, [value]);
  } else {
    found.push(value);
  }
}

function groupIn(groups: Map<Entry, Group>, entry: Entry): Group {
  const found = groups.get(entry) ?? { turns: [], title: false, exact: false };
  groups.set(entry, found);
  return found;
}

function union<T>(
  index: ReadonlyMap<string, T[]>,
  terms: readonly string[]
): ReadonlySet<T> {
  const found = new Set<T>();
  for (const term of terms) {
    for (const value of index.get(term) ?? []) {
      found.add(value);
    }
  }
  return found;
}

function intersect<T>(sets: readonly ReadonlySet<T>[]): ReadonlySet<T> {
  const [first, ...rest] = [...sets].sort((a, b) => a.size - b.size);
  if (first === undefined) {
    return new Set<T>();
  }
  const found = new Set<T>();
  for (const value of first) {
    if (rest.every((set) => set.has(value))) {
      found.add(value);
    }
  }
  return found;
}
