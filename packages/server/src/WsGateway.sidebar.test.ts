import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionFixture } from "#core/session/fixtures/SessionFixture";
import { SessionLease } from "#core/session/SessionLease";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { until } from "#core/shared/fixtures/wait";
import type { ProjectView, SessionSummaryView } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

/**
 * What the sidebar writes down beside pi's sessions: archived, held unread,
 * pinned, named. No model ever answers here — none of it runs a turn.
 */
let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

const metaPath = (): string => join(tmp, "sessions.json");

async function startGateway(): Promise<void> {
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: metaPath(),
  });
  gateway.start();
}

async function connect(
  options: {
    readonly sessionId?: string;
    readonly attentive?: boolean;
  } = {}
): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp, ...options });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function pathOf(sessionId: string): string {
  return join(agentDir, "sessions", "written", `${sessionId}.jsonl`);
}

/**
 * Complete enough to be opened, not only listed — the usage the answer
 * carries is what pi totals the moment an agent adopts the file — and dated
 * `repliedAt`, so the page's modified-time order is the order these were
 * written in and not the order the disk clock saw them.
 */
async function writeSession(
  id: string,
  repliedAt: string,
  cwd: string = tmp
): Promise<void> {
  await SessionFixture.write({
    agentDir,
    id,
    cwd,
    repliedAt,
    usage: true,
    dated: true,
  });
}

/** A session nobody ever said anything in: pi's header and not one entry under it. */
async function writeEmptySession(
  id: string,
  createdAt: string,
  cwd: string = tmp
): Promise<void> {
  await mkdir(join(agentDir, "sessions", "written"), { recursive: true });
  await Bun.write(
    pathOf(id),
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: createdAt, cwd })}\n`
  );
  await touch(id, createdAt);
}

async function touch(id: string, at: string): Promise<void> {
  const seconds = Date.parse(at) / 1000;
  await utimes(pathOf(id), seconds, seconds);
}

function ids(rows: readonly SessionSummaryView[]): readonly string[] {
  return rows.map((row) => row.sessionId);
}

function projectOf(
  projects: readonly ProjectView[],
  cwd: string
): ProjectView | undefined {
  return projects.find((project) => project.cwd === cwd);
}

/** The sidecar as it is on disk, which is the only place any of this survives. */
async function stored(): Promise<{
  readonly sessions: Record<string, unknown>;
  readonly projects: Record<string, unknown>;
  readonly pins: readonly string[];
}> {
  return (await Bun.file(metaPath()).json()) as {
    sessions: Record<string, unknown>;
    projects: Record<string, unknown>;
    pins: readonly string[];
  };
}

function idFor(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const ONE = idFor(1);
const TWO = idFor(2);
const THREE = idFor(3);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-sidebar-test-"));
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
  await startGateway();
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

test("puts a session away, and hands it back on the archived scope", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(2));
  await writeSession(TWO, SessionFixture.minutesAgo(1));
  const probe = await connect();

  expect((await probe.setArchived(ONE, true)).success).toBe(true);

  const live = await probe.listSessions();
  expect(ids(live)).not.toContain(ONE);
  expect(ids(live)).toContain(TWO);

  // Not deleted — asked for by name, it is still there, and says so.
  const away = await probe.listSessions({ archived: true });
  expect(ids(away)).toEqual([ONE]);
  expect(away[0]?.archived).toBe(true);
  expect(away[0]?.title).toBe("say hello");

  await probe.setArchived(ONE, false);
  expect(ids(await probe.listSessions())).toContain(ONE);
  expect(await probe.listSessions({ archived: true })).toEqual([]);
});

test("cuts the page after the archived are gone, not before", async () => {
  // This probe's own session is written first, so it is the oldest of the four.
  const probe = await connect();
  await writeSession(ONE, SessionFixture.minutesAgo(3));
  await writeSession(TWO, SessionFixture.minutesAgo(2));
  await writeSession(THREE, SessionFixture.minutesAgo(1));

  await probe.setArchived(THREE, true);

  // Filtered first, the page is the two live sessions under the archived one.
  // Cut first, it would be the one row left over from a page of two.
  expect(ids(await probe.listSessions({ limit: 2 }))).toEqual([TWO, ONE]);
});

test("keeps a mark made by hand through a listing and a re-attach", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect({ sessionId: ONE });
  expect((await probe.markUnread(ONE, true)).success).toBe(true);

  // Twice: reading the catalogue is not reading the session, and a listing
  // that consumed the mark would consume it before anybody saw the dot.
  expect(SessionFixture.rowIn(await probe.listSessions(), ONE)?.unread).toBe(
    true
  );
  expect(SessionFixture.rowIn(await probe.listSessions(), ONE)?.unread).toBe(
    true
  );
  probe.close();

  // Nor is a reconnect from a tab nobody is looking at.
  const hidden = await connect({ sessionId: ONE, attentive: false });
  expect(SessionFixture.rowIn(await hidden.listSessions(), ONE)?.unread).toBe(
    true
  );

  // Coming back to it is: the read is the one thing that clears the mark.
  await hidden.attention(true);
  expect(
    SessionFixture.rowIn(await hidden.listSessions(), ONE)?.unread
  ).toBeUndefined();
  expect((await stored()).sessions[ONE]).toBeUndefined();
});

test("names a session it has never opened, and gives its opening message back", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();
  expect(SessionFixture.rowIn(await probe.listSessions(), ONE)?.title).toBe(
    "say hello"
  );

  // Whitespace collapsed the way pi stores it, and no stream anywhere: this
  // session has only ever been a file to this server.
  expect((await probe.rename(ONE, "  Parser   work ")).success).toBe(true);
  const named = SessionFixture.rowIn(await probe.listSessions(), ONE);
  expect(named?.title).toBe("Parser work");
  expect(named?.named).toBe(true);

  expect((await probe.rename(ONE, null)).success).toBe(true);
  const cleared = SessionFixture.rowIn(await probe.listSessions(), ONE);
  expect(cleared?.title).toBe("say hello");
  expect(cleared?.named).toBeUndefined();
});

test("names the session it is attached to, through the agent holding it", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect({ sessionId: ONE });

  await probe.rename(ONE, "Live work");
  const named = SessionFixture.rowIn(await probe.listSessions(), ONE);
  expect(named?.title).toBe("Live work");
  expect(named?.named).toBe(true);

  await probe.rename(ONE, null);
  const cleared = SessionFixture.rowIn(await probe.listSessions(), ONE);
  expect(cleared?.title).toBe("say hello");
  expect(cleared?.named).toBeUndefined();
});

test("tells every other connection what one of them changed", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const one = await connect();
  const two = await connect();
  const heard = () =>
    two.events.filter(
      (event) => event.type === "session_meta" || event.type === "project_meta"
    );

  await one.setArchived(ONE, true);
  await one.markUnread(ONE, true);
  await one.setPinned(tmp, true);
  await one.setExpanded(tmp, true);
  await one.setLabel(tmp, "Strings");
  await one.rename(ONE, "Parser work");

  // No session file moved for three of these, so no `sessions_changed` will
  // follow them: this is the only word the other window gets.
  await until(() => heard().length === 6, "the six broadcasts", 20_000);
  expect(heard()).toEqual([
    { type: "session_meta", sessionId: ONE, archived: true },
    { type: "session_meta", sessionId: ONE, unread: true },
    { type: "project_meta", cwd: tmp, pinned: true },
    // A patch, like the `session_meta` rows above it: the fold says nothing
    // about the pin it was just given, so neither can clear the other.
    { type: "project_meta", cwd: tmp, expanded: true },
    { type: "project_meta", cwd: tmp, label: "Strings" },
    { type: "session_meta", sessionId: ONE, name: "Parser work" },
  ]);
});

/** The fold is the server's, so a second window opens to the sidebar the first one arranged. */
test("a listing carries the fold each project was left at", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();

  const folded = await probe.catalogue();
  expect(folded.projects.map((project) => project.expanded)).toEqual([
    undefined,
  ]);

  await probe.setExpanded(tmp, true);

  const opened = await probe.catalogue();
  expect(opened.projects.map((project) => project.expanded)).toEqual([true]);
});

/** The name is the server's too, and it is a name for the sidebar alone: the directory keeps the one it has. */
test("a listing carries the name each project was given", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();

  const plain = await probe.catalogue();
  expect(plain.projects.map((project) => project.label)).toEqual([undefined]);
  expect(plain.projects.map((project) => project.cwd)).toEqual([tmp]);

  await probe.setLabel(tmp, "Strings");

  const named = await probe.catalogue();
  expect(named.projects.map((project) => project.label)).toEqual(["Strings"]);
  expect(named.projects.map((project) => project.cwd)).toEqual([tmp]);

  await probe.setLabel(tmp, null);
  expect((await probe.catalogue()).projects.map((one) => one.label)).toEqual([
    undefined,
  ]);
});

test("refuses a name it cannot write, and changes nothing", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();
  const mark = probe.events.length;

  const unknown = await probe.rename(
    "00000000-0000-4000-8000-00000000dead",
    "X"
  );
  expect(unknown.success).toBe(false);
  expect(unknown.error).toContain("unknown session");

  // Held by the terminal, which may be halfway through a turn of its own.
  const lease = await SessionLease.acquire(pathOf(ONE), "tui");
  if (!lease.ok) {
    throw new Error("the lease was already held");
  }
  const busy = await probe.rename(ONE, "Nope");
  await lease.handle.release();
  expect(busy.success).toBe(false);
  expect(busy.error).toContain("busy");

  expect(SessionFixture.rowIn(await probe.listSessions(), ONE)?.title).toBe(
    "say hello"
  );
  expect(
    probe.events.slice(mark).some((event) => event.type === "session_meta")
  ).toBe(false);
});

test("archives over a socket that never attached", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const socket = new WebSocket(gateway.url);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  // The broadcast reaches this socket too, and reaches it first.
  const answer = new Promise<{ readonly success: boolean }>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as {
        readonly type: string;
        readonly success: boolean;
      };
      if (frame.type === "response") {
        resolve(frame);
      }
    });
  });

  socket.send(
    JSON.stringify({
      id: "1",
      type: "set_session_archived",
      sessionId: ONE,
      value: true,
    })
  );
  const response = await answer;
  socket.close();

  // Putting a row away is something a sidebar does to a session it is not in.
  expect(response.success).toBe(true);
  const probe = await connect();
  expect(ids(await probe.listSessions())).not.toContain(ONE);
});

test("forgets a session that is gone, and keeps the pins", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();
  await probe.setArchived(ONE, true);
  await probe.setPinned(tmp, true);

  // The pin is the directory's, so it rides the project rather than the row.
  const { sessions: away, projects } = await probe.catalogue({
    archived: true,
  });
  expect(ids(away)).toEqual([ONE]);
  expect(projectOf(projects, tmp)?.pinned).toBe(true);
  expect(Object.keys((await stored()).sessions)).toEqual([ONE]);

  await rm(pathOf(ONE));
  await probe.listSessions();

  // And outlives every session that was ever in it.
  const after = await stored();
  expect(after.sessions).toEqual({});
  expect(after.projects).toEqual({ [tmp]: { pinned: true } });
});

test("ranks the pinned projects, and tells every window when the order moves", async () => {
  const one = join(tmp, "one");
  const two = join(tmp, "two");
  await writeSession(ONE, SessionFixture.minutesAgo(2), one);
  await writeSession(TWO, SessionFixture.minutesAgo(1), two);
  const probe = await connect();
  const other = await connect();
  const orders = () =>
    other.events.flatMap((event) =>
      event.type === "pins_changed" ? [event.order] : []
    );

  await probe.setPinned(one, true);
  await probe.setPinned(two, true);

  // The newest pin is the top one, and the rank rides with the listing: a
  // window that opens tomorrow needs no broadcast to sort them.
  const ranked = (await probe.catalogue()).projects;
  expect(projectOf(ranked, two)?.pinRank).toBe(0);
  expect(projectOf(ranked, one)?.pinRank).toBe(1);

  await probe.setPinOrder([one, two]);
  const moved = (await probe.catalogue()).projects;
  expect(projectOf(moved, one)?.pinRank).toBe(0);
  expect(projectOf(moved, two)?.pinRank).toBe(1);
  expect((await stored()).pins).toEqual([one, two]);

  // Three words to the other window: both pins, and the move.
  await until(() => orders().length === 3, "the pin broadcasts", 20_000);
  expect(orders()).toEqual([[one], [two, one], [one, two]]);

  // An order is only ever where a pin sits, never whether it is one: naming a
  // directory that is not pinned adds nothing.
  await probe.setPinOrder([join(tmp, "never"), two, one]);
  expect((await stored()).pins).toEqual([two, one]);
});

test("hands a pin back to a server that has been restarted under it", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(1));
  const probe = await connect();
  await probe.setPinned(tmp, true);
  probe.close();

  await gateway.stop();
  await registry.disposeAll();
  await startGateway();

  // Read off the sidecar rather than held in the process that was told: a
  // phone opening the sidebar tomorrow is the case this is for.
  const restarted = await connect();
  const { sessions, projects } = await restarted.catalogue();
  expect(SessionFixture.rowIn(sessions, ONE)).toBeDefined();
  expect(projectOf(projects, tmp)?.pinned).toBe(true);
});

/** Sessions a minute apart, oldest first, so the last one written is the newest. */
async function writeProject(
  cwd: string,
  from: number,
  count: number
): Promise<readonly string[]> {
  const written: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = idFor(from + index);
    await writeSession(id, SessionFixture.minutesAgo(count - index), cwd);
    written.push(id);
  }
  return written.reverse();
}

test("a session nobody ever spoke in is not a row, and is still one of its project's files", async () => {
  await writeSession(ONE, SessionFixture.minutesAgo(2));
  await writeEmptySession(TWO, SessionFixture.minutesAgo(1));
  const probe = await connect();

  // All it could be called is a truncated uuid, so it is not offered at all.
  const { sessions, projects } = await probe.catalogue();
  expect(ids(sessions)).toEqual([ONE]);
  // Counted all the same: the count is the header scan's, and a client asking
  // for more of this directory is owed the chance to find nothing new.
  expect(projectOf(projects, tmp)).toEqual({ cwd: tmp, count: 2 });
});

test("keeps a quiet project on the page beside a busy one", async () => {
  const busy = join(tmp, "busy");
  const quiet = join(tmp, "quiet");
  await writeSession(idFor(10), SessionFixture.minutesAgo(90), quiet);
  const recent = await writeProject(busy, 20, 6);
  const probe = await connect();

  // Flat, the page is the busy directory and nothing else: the quiet project
  // is six sessions from the top of a list four rows long.
  expect(ids(await probe.listSessions({ limit: 4 }))).toEqual(
    recent.slice(0, 4)
  );

  // Capped, the budget the busy one cannot spend goes to the project that has
  // been sitting under it.
  expect(ids(await probe.listSessions({ limit: 4, perProject: 2 }))).toEqual([
    ...recent.slice(0, 2),
    idFor(10),
  ]);
});

test("spends a project's budget on rows a client can see, not on the ones it filtered", async () => {
  const project = join(tmp, "one-visible");
  await writeSession(ONE, SessionFixture.minutesAgo(3), project);
  await writeEmptySession(TWO, SessionFixture.minutesAgo(2), project);
  await writeSession(THREE, SessionFixture.minutesAgo(1), project);
  const probe = await connect();
  await probe.setArchived(THREE, true);

  // Cut before the archived one was dropped, the budget goes on it and the
  // project shows nothing; cut before the empty one was dropped, the same.
  const { sessions, projects } = await probe.catalogue({ perProject: 1 });
  expect(ids(sessions)).toEqual([ONE]);
  expect(projectOf(projects, project)).toEqual({ cwd: project, count: 2 });
});

test("counts what a project holds, not what fitted on the page", async () => {
  const project = join(tmp, "deep");
  const recent = await writeProject(project, 30, 5);
  const probe = await connect();

  const { sessions, projects } = await probe.catalogue({ perProject: 2 });
  expect(ids(sessions)).toEqual(recent.slice(0, 2));
  expect(projectOf(projects, project)).toEqual({ cwd: project, count: 5 });

  // Put away, and the same directory is counted by the scope that is asking.
  await probe.setArchived(recent[0]!, true);
  expect(
    projectOf((await probe.catalogue({ perProject: 2 })).projects, project)
  ).toEqual({ cwd: project, count: 4 });
  expect(
    projectOf(
      (await probe.catalogue({ archived: true, perProject: 2 })).projects,
      project
    )
  ).toEqual({ cwd: project, count: 1 });

  // And the pin is the project's own, beside the count rather than on a row.
  await probe.setPinned(project, true);
  expect(
    projectOf((await probe.catalogue({ perProject: 2 })).projects, project)
  ).toEqual({ cwd: project, count: 4, pinned: true, pinRank: 0 });
});

test("lists a page wider than the gate its reads fan out through", async () => {
  const left = join(tmp, "left");
  const right = join(tmp, "right");
  const [first, second] = await Promise.all([
    writeProject(left, 100, 24),
    writeProject(right, 200, 24),
  ]);
  const probe = await connect();

  // Two projects deeper than either gate, and every row arrives, once, in the
  // order the last reply settled.
  const rows = await probe.listSessions({ limit: 100, perProject: 100 });
  expect(new Set(ids(rows))).toEqual(new Set([...first, ...second]));
  expect(ids(rows).length).toBe(first.length + second.length);
  expect(
    rows.every(
      (row, index) => index === 0 || row.settledAt <= rows[index - 1]!.settledAt
    )
  ).toBe(true);
});
