import "../test/dom";

import { render } from "@solidjs/web";
import { beforeEach, expect, jest, setSystemTime, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { SessionSummaryView } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { Sidebar } from "./Sidebar";

const SESSIONS: readonly SessionSummaryView[] = [
  {
    sessionId: "aaaaaaaa-1111",
    cwd: "/home/ada/dev/pim",
    createdAt: 0,
    modifiedAt: 0,
    title: "Modernise the string building",
    head: 12,
  },
  {
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    createdAt: 0,
    modifiedAt: 0,
    head: 0,
  },
];

/** Offline: `listSessions` is stubbed, which is the only thing this reads. */
function paint(
  onNavigate?: () => void,
  seen?: Record<string, number>
): {
  readonly host: HTMLElement;
  readonly switched: string[];
  readonly store: SessionStore;
} {
  // The read cursor is this browser's, so it is seeded where it lives.
  localStorage.setItem("pim.seen", JSON.stringify(seen ?? {}));
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  const switched: string[] = [];
  store.listSessions = async () => SESSIONS;
  store.switchTo = async (sessionId) => {
    switched.push(sessionId);
  };
  const host = mountPoint();
  render(
    () => <Sidebar store={store} {...(onNavigate ? { onNavigate } : {})} />,
    host
  );
  flush();
  return { host, switched, store };
}

/** Both live in the browser, so both are seeded where the browser keeps them. */
function draft(sessionId: string, text: string): void {
  localStorage.setItem("pim.drafts", JSON.stringify({ [sessionId]: text }));
}

function unwritten(sessionId: string): void {
  localStorage.setItem(
    "pim.unwritten",
    JSON.stringify({ sessionId, cwd: "/home/ada/dev/pim", sent: false })
  );
}

beforeEach(() => {
  localStorage.clear();
});

test("one flat row per session: name, cwd and how long ago", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
  // A session with nothing written to it yet has only its id for a name.
  expect(rows[1]?.textContent).toContain("bbbbbbbb");
  expect(rows[0]?.textContent).toContain("~/dev/pim");
  expect(rows[1]?.textContent).toContain("/srv/other");
});

test("the dot marks a session written past what this browser has painted", async () => {
  const { host } = paint(undefined, { "aaaaaaaa-1111": 12 });
  await Bun.sleep(0);
  flush();

  const dots = [...host.querySelectorAll('[aria-label="Unread"]')];
  // The first session is read up to its head; the second was never opened and
  // has nothing on disk either, so neither is unread.
  expect(dots).toHaveLength(0);

  const { host: stale } = paint(undefined, { "aaaaaaaa-1111": 4 });
  await Bun.sleep(0);
  flush();
  expect(
    stale.querySelectorAll('li:first-child [aria-label="Unread"]')
  ).toHaveLength(1);
});

test("picking a row attaches to it and tells the host to get out of the way", async () => {
  const navigated: number[] = [];
  const { host, switched } = paint(() => navigated.push(1));
  await Bun.sleep(0);
  flush();

  host
    .querySelectorAll("li button")[1]!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(switched).toEqual(["bbbbbbbb-2222"]);
  expect(navigated).toEqual([1]);
});

test("a row's age follows the clock, not the next render", async () => {
  // The row's clock is a `setInterval`, so it has to be the fake one by the
  // time the component mounts. This resets the wall clock, hence the order.
  jest.useFakeTimers();
  // The fixture's sessions were last written at the epoch, so the mocked
  // wall clock *is* the age.
  setSystemTime(new Date(30_000));
  const { host } = paint();
  // Not `Bun.sleep`: under fake timers nothing advances the clock but this
  // test, and the stubbed `listSessions` only needs its microtask drained.
  await Promise.resolve();
  flush();
  const age = (): string | undefined =>
    host.querySelector("li button > div:last-child > div:last-child")
      ?.textContent ?? undefined;
  expect(age()).toBe("30s");

  setSystemTime(new Date(90_000));
  // Nothing here re-renders the list; only the component's own tick does.
  jest.advanceTimersByTime(1000);
  flush();
  expect(age()).toBe("1m");
  jest.useRealTimers();
  setSystemTime();
});

test("the server row names the host and tints itself with the connection", () => {
  const { host } = paint();

  expect(host.textContent).toContain("127.0.0.1:1");
  expect(host.innerHTML).toContain("text-rose-400");
});

test("a new chat is a row before it is a file, marked and ageless", async () => {
  unwritten("draft-1");
  draft("draft-1", "rework the sidebar");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  // Newest first, and nothing is newer than the chat being started.
  expect(rows).toHaveLength(3);
  // Named by the message it is about to send, exactly as a written session is
  // named by the one it did.
  expect(rows[0]?.textContent).toContain("rework the sidebar");
  // An amber pencil and nothing else: the row it sits on is the selected
  // one, whose fill the old neutral pill was painted in.
  expect(rows[0]?.textContent).not.toContain("draft");
  expect(rows[0]?.innerHTML).toContain("i-griddy-icons:edit");
  expect(rows[0]?.innerHTML).toContain("text-amber-400");
  // No age: nothing has been written for a clock to measure.
  expect(rows[0]?.textContent).not.toMatch(/\d+[smhd]/);
});

test("a new chat nobody has typed into is not a row at all", async () => {
  unwritten("draft-1");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  // Two, not three: an empty composer is not a conversation.
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(host.innerHTML).not.toContain("i-griddy-icons:edit");
});

test("the pencil follows the message, onto a listed session's row", async () => {
  draft("bbbbbbbb-2222", "not sent yet");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[0]?.innerHTML).not.toContain("i-griddy-icons:edit");
  // Beside the age, not instead of it: a session on disk has both to say.
  expect(rows[1]?.innerHTML).toContain("i-griddy-icons:edit");
  expect(rows[1]?.textContent).toMatch(/\d+[smhd]/);
});

test("the unwritten row gives way to the real one, never doubles it", async () => {
  unwritten("aaaaaaaa-1111");
  draft("aaaaaaaa-1111", "already on disk");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
});

test("a running turn spins where the age would be", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();
  expect(host.innerHTML).not.toContain("animate-spin");

  store.ingest({
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "aaaaaaaa-1111",
    cwd: "/home/ada/dev/pim",
    head: 12,
  });
  store.ingest({
    type: "session_state",
    cwd: "/home/ada/dev/pim",
    model: "m",
    thinking: "off",
    cost: 0,
    status: "thinking",
  });
  flush();

  const row = host.querySelector("li")!;
  expect(row.innerHTML).toContain("animate-spin");
  // The mark stands in for the age rather than beside it.
  expect(row.textContent).not.toMatch(/\d+[smhd]/);
});

test("a turn keeps spinning on the row of the session left behind", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  // Nothing here is attached to that session: only the server can say that a
  // conversation nobody is reading is still being written.
  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "tool",
  });
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[0]?.innerHTML).toContain("animate-spin");
  // And only that row: every other session has its age to show.
  expect(rows[1]?.innerHTML).not.toContain("animate-spin");
  expect(rows[1]?.textContent).toMatch(/\d+[smhd]/);
});

test("the listing is re-read when a turn ends, so the age is since the reply", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  let listings = 0;
  store.listSessions = async () => {
    listings += 1;
    // Written to just now, which is what a finished turn leaves behind.
    return SESSIONS.map((session) =>
      session.sessionId === "aaaaaaaa-1111"
        ? { ...session, modifiedAt: Date.now() }
        : session
    );
  };

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  // A turn starting moves nothing a row draws: the spinner is the status, and
  // a directory scan would answer with what is already on screen.
  expect(listings).toBe(0);

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "idle",
  });
  flush();
  await Bun.sleep(0);
  flush();

  expect(listings).toBe(1);
  const row = host.querySelector("li")!;
  expect(row.innerHTML).not.toContain("animate-spin");
  expect(row.textContent).toContain("0s");
});
