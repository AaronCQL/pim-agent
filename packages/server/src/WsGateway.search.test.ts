import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SearchCorpus } from "#core/session/fixtures/SearchCorpus";
import type { SearchRange } from "#core/session/SearchIndex";
import {
  SessionRegistry,
  type SessionSummary,
} from "#core/session/SessionRegistry";
import type { SearchHitView } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * Search over the wire: the fixture corpus of Phase 1a, read through a real
 * socket. No model ever answers here — nothing in it runs a turn.
 */
const SESSIONS = 13;

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let summaries: readonly SessionSummary[];
let probes: ProbeClient[] = [];

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

/** Dates every file by the conversation in it, so a page is the corpus's own order and not the disk's. */
async function age(): Promise<void> {
  for (const summary of summaries) {
    const seconds = summary.createdAt / 1000;
    await utimes(summary.path, seconds, seconds);
  }
}

function summaryOf(sessionId: string): SessionSummary {
  return summaries.find((summary) => summary.sessionId === sessionId)!;
}

function ids(rows: readonly { readonly sessionId: string }[]): string[] {
  return rows.map((row) => row.sessionId);
}

function hitOf(
  hits: readonly SearchHitView[],
  sessionId: string
): SearchHitView {
  return hits.find((hit) => hit.sessionId === sessionId)!;
}

function marked(text: string, ranges: readonly SearchRange[]): string[] {
  return ranges.map(([start, end]) => text.slice(start, end));
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-search-wire-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
        },
      },
    })
  );
  summaries = await SearchCorpus.write(join(agentDir, "sessions"));
  await age();
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
  });
  gateway.start();
});

afterEach(async () => {
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  await gateway.stop();
  await registry.disposeAll();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("finds a session no page of the sidebar's could have reached", async () => {
  const probe = await connect();
  const page = await probe.listSessions({ limit: 4 });

  // Ten newer sessions sit on top of it, eight of them in one directory, so a
  // page of the sidebar's is that directory and nothing else.
  expect(page).toHaveLength(4);
  expect(ids(page)).not.toContain("old-note");
  expect(page.every((row) => row.cwd === summaryOf("lease-turn").cwd)).toBe(
    true
  );

  const answer = await probe.search("outlives");
  expect(ids(answer.hits)).toEqual(["old-note"]);
  expect(answer.scanned).toBe(SESSIONS);
});

test("searches the archived too and badges them, or leaves them out on request", async () => {
  const probe = await connect();
  expect((await probe.setArchived("old-note", true)).success).toBe(true);

  // You archived it because you stopped looking; search is how it comes back.
  const both = await probe.search("lease");
  expect(ids(both.hits)).toContain("old-note");
  expect(hitOf(both.hits, "old-note").archived).toBe(true);
  expect(hitOf(both.hits, "lease-turn").archived).toBeUndefined();
  expect(both.scanned).toBe(SESSIONS);

  const live = await probe.search("lease", { archived: false });
  expect(ids(live.hits)).not.toContain("old-note");
  expect(live.scanned).toBe(SESSIONS - 1);

  const away = await probe.search("lease", { archived: true });
  expect(ids(away.hits)).toEqual(["old-note"]);
  expect(away.scanned).toBe(1);
});

test("answers an empty query with no hits and a real count", async () => {
  const probe = await connect();
  const warm = await probe.search("");

  expect(warm.hits).toEqual([]);
  expect(warm.dropped).toEqual([]);
  expect(warm.scanned).toBe(SESSIONS);

  // And the index it built is the one the first typed query is answered from.
  expect(ids((await probe.search("quokka")).hits)).toEqual(["quokka"]);
});

test("carries every match range across the wire as a pair into the string it marks", async () => {
  const probe = await connect();
  const hit = hitOf((await probe.search("lease")).hits, "lease-turn");
  const title = hit.title!;
  const spoken = hit.snippets.find((snippet) => snippet.role === "assistant")!;

  // JSON has no tuples: what arrives is the two-element array a client slices with.
  expect(hit.titleRanges).toEqual([
    [title.indexOf("lease"), title.indexOf("lease") + "lease".length],
  ]);
  expect(marked(title, hit.titleRanges)).toEqual(["lease"]);

  // The half of an identifier the tokenizer split, still marked after the trip.
  expect(spoken.text).toContain("SessionLease");
  expect(marked(spoken.text, spoken.ranges)).toContain("Lease");
  expect(marked(spoken.text, spoken.ranges)).not.toContain("SessionLease");
});

test("scopes a search to one working directory", async () => {
  const probe = await connect();
  const answer = await probe.search("sidebar", {
    cwd: summaryOf("editor-sidebar").cwd,
  });

  expect(ids(answer.hits)).toEqual(["editor-sidebar"]);
  expect(answer.scanned).toBe(2);
});

test("names the word it had to drop to answer at all", async () => {
  const probe = await connect();
  const answer = await probe.search("quokka lease");

  expect(answer.dropped).toEqual(["quokka"]);
  expect(ids(answer.hits)).toContain("lease-turn");
});

test("every hit carries a clock, answered or not", async () => {
  const quiet = summaryOf("quiet-note");
  await SearchCorpus.edit(quiet, (text) =>
    text
      .split("\n")
      .filter((line) => !line.includes(`"role":"assistant"`))
      .join("\n")
  );
  const probe = await connect();

  const answered = await probe.search("lease");
  expect(answered.hits.every((hit) => hit.settledAt > 0)).toBe(true);

  // Nothing ever settled a turn here, so the row is dated by the session's own start.
  expect(hitOf((await probe.search("interesting")).hits, "quiet-note")).toEqual(
    expect.objectContaining({ settledAt: quiet.createdAt })
  );
});
