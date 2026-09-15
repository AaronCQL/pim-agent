import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { EventLog } from "./EventLog";
import { SearchCorpus } from "./fixtures/SearchCorpus";
import {
  SearchIndex,
  type SearchAnswer,
  type SearchHit,
  type SearchRange,
} from "./SearchIndex";
import type { SessionSummary } from "./SessionRegistry";

const SESSIONS = 13;

const MMORPG = "/home/dev/mmorpg";

let tmp: string;
let summaries: readonly SessionSummary[];
let listed: number;
let clock: number;
let index: SearchIndex;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-search-index-test-"));
  summaries = await SearchCorpus.write(join(tmp, "sessions"));
  const list = SearchCorpus.lister(summaries);
  listed = 0;
  clock = 1_000_000;
  index = new SearchIndex({
    list: () => {
      listed += 1;
      return list();
    },
    now: () => clock,
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function ids(answer: SearchAnswer): string[] {
  return answer.hits.map((hit) => hit.sessionId);
}

function summaryOf(sessionId: string): SessionSummary {
  return summaries.find((summary) => summary.sessionId === sessionId)!;
}

function hitOf(answer: SearchAnswer, sessionId: string): SearchHit {
  return answer.hits.find((hit) => hit.sessionId === sessionId)!;
}

function marked(
  text: string,
  ranges: readonly SearchRange[]
): readonly string[] {
  return ranges.map(([start, end]) => text.slice(start, end));
}

function lowered(marks: readonly string[]): string[] {
  return [...new Set(marks.map((mark) => mark.toLowerCase()))].sort();
}

/** Every mark a whole answer draws, on the title and in every snippet. */
function everyMark(answer: SearchAnswer): readonly string[] {
  return answer.hits.flatMap((hit) => [
    ...marked(hit.title ?? "", hit.titleRanges),
    ...hit.snippets.flatMap((snippet) => marked(snippet.text, snippet.ranges)),
  ]);
}

function expectWellFormed(answer: SearchAnswer): void {
  for (const hit of answer.hits) {
    expectRanges(hit.title ?? "", hit.titleRanges);
    for (const snippet of hit.snippets) {
      expectRanges(snippet.text, snippet.ranges);
    }
  }
  const exact = answer.hits.filter((hit) => !hit.typos);
  expect(answer.hits.slice(0, exact.length)).toEqual(exact);
}

function expectRanges(text: string, ranges: readonly SearchRange[]): void {
  let reached = 0;
  for (const [start, end] of ranges) {
    expect(start).toBeGreaterThanOrEqual(reached);
    expect(end).toBeGreaterThan(start);
    expect(end).toBeLessThanOrEqual(text.length);
    reached = end;
  }
}

test("answers a session no page budget would have reached", async () => {
  const answer = await index.search("outlives");

  expect(ids(answer)).toEqual(["old-note"]);
  expect(answer.scanned).toBe(SESSIONS);
});

test("one row per session, however many messages matched", async () => {
  const answer = await index.search("lease");

  expect(ids(answer).filter((id) => id === "lease-turn")).toHaveLength(1);
  expect(hitOf(answer, "lease-turn").total).toBe(3);
  expect(hitOf(answer, "lease-turn").snippets).toHaveLength(2);
});

test("a session matching by title and by content appears once", async () => {
  const answer = await index.search("lease");
  const hit = hitOf(answer, "lease-turn");

  expect(hit.titleRanges.length).toBeGreaterThan(0);
  expect(hit.snippets.length).toBeGreaterThan(0);
  expect(ids(answer)).toEqual([...new Set(ids(answer))]);
});

test("a correctly spelled query never reaches for its neighbours", async () => {
  const answer = await index.search("lease");

  expect(ids(answer).sort()).toEqual([
    "daemon-leases",
    "lease-turn",
    "old-note",
  ]);
  expect(answer.hits.every((hit) => !hit.typos)).toBe(true);
  expect(ids(answer)).not.toContain("telemetry");
});

test("a single typo recovers the result set the spelling would have", async () => {
  const typed = await index.search("sidbar");
  const spelled = await index.search("sidebar");

  expect(ids(typed).sort()).toEqual(ids(spelled).sort());
  expect(typed.hits.every((hit) => hit.typos)).toBe(true);
  expect(spelled.hits.every((hit) => !hit.typos)).toBe(true);
});

test("a token under four characters is never typo-expanded", async () => {
  expect(ids(await index.search("web"))).toEqual(["web-client"]);
  expect(ids(await index.search("wbe"))).toEqual([]);
});

test("two typos need seven characters", async () => {
  expect(ids(await index.search("sidbat"))).toEqual([]);
  expect(ids(await index.search("sidbart")).sort()).toEqual([
    "editor-sidebar",
    "sidebar-rows",
  ]);
});

test("a transposition costs one edit", async () => {
  const answer = await index.search("gatewya");

  expect(ids(answer).sort()).toEqual(ids(await index.search("gateway")).sort());
  expect(answer.hits.every((hit) => hit.typos)).toBe(true);
});

test("prefix matching applies to the last word alone", async () => {
  expect(ids(await index.search("daemon lease")).sort()).toEqual([
    "daemon-leases",
    "old-note",
  ]);
  expect(ids(await index.search("lease daemon"))).toEqual(["old-note"]);
});

test("a query that returns too little drops its rarest word and says so", async () => {
  const answer = await index.search("quokka lease");

  expect(answer.dropped).toEqual(["quokka"]);
  expect(ids(answer).sort()).toEqual(ids(await index.search("lease")).sort());
});

test("a dropped word contributes no ranges", async () => {
  const answer = await index.search("quokka lease");

  expect(lowered(everyMark(answer))).toEqual(["lease", "leases"]);
});

test("an identifier is found by its parts, and only its parts are marked", async () => {
  const hit = hitOf(await index.search("lease"), "lease-turn");
  const spoken = hit.snippets.find((snippet) => snippet.role === "assistant")!;

  expect(spoken.text).toContain("SessionLease");
  expect(marked(spoken.text, spoken.ranges)).toContain("Lease");
  expect(marked(spoken.text, spoken.ranges)).not.toContain("SessionLease");
});

test("a typo marks the term that matched, and a prefix marks the whole word", async () => {
  expect(lowered(everyMark(await index.search("sidbar")))).toEqual(["sidebar"]);
  expect(lowered(everyMark(await index.search("dae")))).toEqual(["daemon"]);
});

test("every range lands inside the string it marks", async () => {
  for (const query of ["lease", "sidbar", "dae", "quokka lease", "gatewya"]) {
    expectWellFormed(await index.search(query));
  }
});

test("a title's ranges are cut to the clamp, not to the message", async () => {
  const hit = hitOf(await index.search("throughput"), "long-opening");

  expect(hit.title).toEndWith("…");
  expectRanges(hit.title!, hit.titleRanges);
  expect(marked(hit.title!, hit.titleRanges)).toEqual(["Throughput"]);
  // Four tokens either side of the match, and the second `throughput` is far
  // past them: a snippet is a window, not the message.
  expect(hit.snippets[0]!.text).toBe("Throughput on the render path");
});

test("a title hit outranks a user hit, which outranks the agent's prose", async () => {
  expect(ids(await index.search("gateway"))).toEqual([
    "ws-gateway",
    "web-client",
    "sidebar-rows",
  ]);
});

test("recency breaks a tie between two hits of the same kind", async () => {
  expect(ids(await index.search("sidebar"))).toEqual([
    "sidebar-rows",
    "editor-sidebar",
  ]);
});

test("the snippets lead with what you asked, then with the answer", async () => {
  const hit = hitOf(await index.search("lease"), "lease-turn");

  expect(hit.snippets.map((snippet) => snippet.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(hit.snippets[0]!.seq).toBeLessThan(hit.snippets[1]!.seq);
});

test("the parsed user text is indexed, not the attachment markers", async () => {
  expect(ids(await index.search("unnamed"))).toEqual(["attachment"]);
  expect(ids(await index.search("attachment"))).toEqual([]);
  expect(ids(await index.search("screenshot"))).toEqual([]);
});

test("an empty query answers nothing and leaves the index built", async () => {
  const answer = await index.search("");

  expect(answer).toEqual({ hits: [], dropped: [], scanned: SESSIONS });
  expect(listed).toBe(1);
  expect(ids(await index.search("quokka"))).toEqual(["quokka"]);
  expect(listed).toBe(1);
});

test("concurrent first queries build the index once", async () => {
  const [, , answer] = await Promise.all([
    index.ready(),
    index.ready(),
    index.search("lease"),
  ]);

  expect(listed).toBe(1);
  expect(answer.hits.length).toBeGreaterThan(0);
});

test("a query inside the throttle does not walk the tree again", async () => {
  await index.search("lease");
  clock += 499;
  await index.search("lease");
  expect(listed).toBe(1);

  clock += 1;
  await index.search("lease");
  expect(listed).toBe(2);
});

test("a hit's title and settle time are the digest's, to the character", async () => {
  for (const query of ["lease", "telemetry", "throughput"]) {
    const answer = await index.search(query);
    expect(answer.hits.length).toBeGreaterThan(0);
    for (const hit of answer.hits) {
      const digest = await new EventLog(hit.path).digest();
      expect(hit.title).toBe(digest.title);
      expect(hit.settledAt).toBe(
        digest.settledAt ?? summaryOf(hit.sessionId).createdAt
      );
      expect(hit.named).toBe(digest.named);
    }
  }
});

test("a session the agent never answered is dated by when it started", async () => {
  const quiet = summaryOf("quiet-note");
  await SearchCorpus.edit(quiet, (text) =>
    text
      .split("\n")
      .filter((line) => !line.includes(`"role":"assistant"`))
      .join("\n")
  );

  const hit = hitOf(await index.search("interesting"), "quiet-note");
  expect((await new EventLog(hit.path).digest()).settledAt).toBeUndefined();
  expect(hit.settledAt).toBe(quiet.createdAt);
});

test("an appended turn is queryable without re-reading the file", async () => {
  await index.search("");
  const quiet = summaryOf("quiet-note");
  // Byte-for-byte as long as the line it replaces: a tail read resumes at an
  // offset, so a fixture that moved one would prove nothing about the offset.
  await SearchCorpus.edit(
    quiet,
    (text) =>
      text.replace(
        "Nothing interesting here yet.",
        "Rewritten and never reread!!!"
      ) +
      SearchCorpus.lineOf(quiet, {
        role: "user",
        text: "The catalogue gained a posting.",
      })
  );
  clock += 500;

  expect(ids(await index.search("catalogue"))).toEqual(["quiet-note"]);
  expect(ids(await index.search("rewritten"))).toEqual([]);
  expect(ids(await index.search("interesting"))).toEqual(["quiet-note"]);
});

test("a rewritten file is read again from the top", async () => {
  await index.search("");
  const quiet = summaryOf("quiet-note");
  await SearchCorpus.edit(quiet, () =>
    [
      `{"type":"session","version":3,"id":"quiet-note","timestamp":"2026-07-01T09:00:00.000Z","cwd":"/home/dev/notes"}`,
      SearchCorpus.lineOf(quiet, {
        role: "user",
        text: "Compacted into one line.",
      }).trim(),
      "",
    ].join("\n")
  );
  clock += 500;

  expect(ids(await index.search("compacted"))).toEqual(["quiet-note"]);
  expect(ids(await index.search("interesting"))).toEqual([]);
});

test("a session that left the tree leaves the index with it", async () => {
  await index.search("");
  await rm(summaryOf("quokka").path);
  clock += 500;

  const answer = await index.search("quokka");
  expect(answer.hits).toEqual([]);
  expect(answer.scanned).toBe(SESSIONS - 1);
});

test("the caller scopes the search, and the scope is counted honestly", async () => {
  const scoped = await index.search("sidebar", { cwd: MMORPG });
  expect(ids(scoped)).toEqual(["editor-sidebar"]);
  expect(scoped.scanned).toBe(2);

  const filtered = await index.search("sidebar", {
    accept: (sessionId) => sessionId !== "sidebar-rows",
  });
  expect(ids(filtered)).toEqual(["editor-sidebar"]);
  expect(filtered.scanned).toBe(SESSIONS - 1);

  expect(ids(await index.search("sidebar", { limit: 1 }))).toEqual([
    "sidebar-rows",
  ]);
});

test("the build lowercases tokens, never the corpus", async () => {
  const lower = String.prototype.toLowerCase;
  let longest = 0;
  String.prototype.toLowerCase = function (this: string): string {
    longest = Math.max(longest, this.length);
    return lower.call(this);
  };
  try {
    await index.ready();
  } finally {
    String.prototype.toLowerCase = lower;
  }

  expect(longest).toBeLessThanOrEqual(32);
});
