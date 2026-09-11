import "../test/dom";

import { render } from "@solidjs/web";
import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { flush, untrack } from "solid-js";

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
    settledAt: 0,
    title: "Modernise the string building",
  },
  {
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    createdAt: 0,
    settledAt: 0,
  },
];

/**
 * Offline: the listing is the only thing this reads, so it is the only thing
 * answered. Answered rather than stubbed away, because the marks it carries
 * are the server's and this is where the store takes them from.
 */
function paint(
  onNavigate?: () => void,
  unread: readonly string[] = [],
  onOpenSettings?: () => void
): {
  readonly host: HTMLElement;
  readonly switched: string[];
  readonly store: SessionStore;
} {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  const switched: string[] = [];
  store.client.send = async () => ({
    type: "response",
    id: "1",
    success: true,
    sessions: SESSIONS.map((session) => {
      // A real listing says what each session is doing, so this one does
      // too: the spinner is read off the status, and a row answered for as
      // idle would stop one mid-turn on the next re-list.
      // Untracked: the server this stands in for is answering a request,
      // not deriving a value, and this runs from inside the effect that
      // asked.
      const status = untrack(() => store.state.activity[session.sessionId]);
      return {
        ...session,
        ...(unread.includes(session.sessionId) ? { unread: true } : {}),
        ...(status === undefined || status === "idle" ? {} : { status }),
      };
    }),
  });
  store.switchTo = async (sessionId) => {
    switched.push(sessionId);
  };
  const host = mountPoint();
  render(
    () => (
      <Sidebar
        store={store}
        {...(onNavigate ? { onNavigate } : {})}
        {...(onOpenSettings ? { onOpenSettings } : {})}
      />
    ),
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

// A test that leaves the fake clock running takes every test after it down
// with it: `Bun.sleep` never resolves under one.
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

/**
 * Settles the listing, which resolves through a chain of microtasks: the
 * client's answer, the store's reading of it, and the effect that puts the
 * rows on screen. Drained a hop at a time rather than slept on, because one
 * of these tests runs on a fake clock that only it can move — and until the
 * a row is up rather than for a fixed count, so a hop added to that chain
 * does not turn into a test that sees an empty list. A row is a `li button`:
 * the empty state is an `li` too.
 */
async function listed(host: HTMLElement): Promise<void> {
  for (let hop = 0; hop < 20 && !host.querySelector("li button"); hop += 1) {
    await Promise.resolve();
    flush();
  }
}

test("the header uses the compact pixel wordmark with an accessible name", () => {
  const { host } = paint();
  const logo = host.querySelector("h1 img");
  expect(logo?.getAttribute("src")).toBe("/wordmark.svg");
  expect(logo?.getAttribute("alt")).toBe("PIM");
  expect(logo?.classList.contains("h-5")).toBe(true);
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

test("the dot marks a session that has answered since anything read it", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();
  expect(host.querySelectorAll('[aria-label="Unread"]')).toHaveLength(0);

  const { host: marked, store } = paint(undefined, ["aaaaaaaa-1111"]);
  await Bun.sleep(0);
  flush();
  expect(
    marked.querySelectorAll('li:first-child [aria-label="Unread"]')
  ).toHaveLength(1);

  // Read in another browser, on a cursor this one shares: the dot goes out
  // here without the list being asked for again.
  store.ingest({ type: "session_read", sessionId: "aaaaaaaa-1111" });
  flush();
  expect(marked.querySelectorAll('[aria-label="Unread"]')).toHaveLength(0);
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
  await listed(host);
  const age = (): string | undefined =>
    host.querySelector("li button > div:last-child > div:last-child")
      ?.textContent ?? undefined;
  expect(age()).toBe("30s");

  setSystemTime(new Date(90_000));
  // Nothing here re-renders the list; only the component's own tick does.
  jest.advanceTimersByTime(1000);
  flush();
  expect(age()).toBe("1m");
});

/**
 * Where the app's own controls are, as opposed to the session's: the row
 * under the wordmark, with the least-pressed of them last. What the sidebar
 * used to say about the connection is the topbar's mark and the settings
 * dialog now — a bar that reported a healthy socket every second it was
 * healthy was chrome nobody read.
 */
test("the header carries the app's two buttons and nothing about the socket", () => {
  const opened: number[] = [];
  const { host } = paint(undefined, [], () => opened.push(1));
  const header = host.querySelector("h1")!.closest("div")!.parentElement!;
  const labels = [...header.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label")
  );

  expect(labels).toEqual(["New session", "Settings"]);
  expect(host.textContent).not.toContain("127.0.0.1:1");

  header.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click();
  expect(opened).toHaveLength(1);
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

test("a listed session with no title yet is named by its first message", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  // The listing has the session and no name for it: pi writes the log while
  // the turn runs, and the digest behind the title is a scan of the file the
  // turn is still growing. The row has the message in hand either way.
  store.ingest({
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
  store.ingest({
    seq: 1,
    type: "message",
    messageId: "m1",
    role: "user",
    text: "run the tests",
    timestamp: 0,
  });
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[1]?.textContent).toContain("run the tests");
  expect(rows[1]?.textContent).not.toContain("bbbbbbbb");
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
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
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
    // Settled just now, which is what a finished turn leaves behind.
    return SESSIONS.map((session) =>
      session.sessionId === "aaaaaaaa-1111"
        ? { ...session, settledAt: Date.now() }
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

test("typing into a new chat leaves the rows around it standing", async () => {
  unwritten("draft-1");
  draft("draft-1", "re");
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "draft-1",
    cwd: "/home/ada/dev/pim",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  await Bun.sleep(0);
  flush();

  const before = [...host.querySelectorAll("li")];
  const spinner = host.querySelector(".animate-spin");
  expect(spinner).not.toBeNull();

  store.setDraftText("rework the sidebar");
  flush();

  // The same elements, not merely the same markup: a remounted row starts its
  // spin over, which is what a turn running elsewhere looks like being reset
  // by a keystroke here.
  const after = [...host.querySelectorAll("li")];
  expect(after).toHaveLength(before.length);
  for (const [index, row] of after.entries()) {
    expect(row).toBe(before[index]!);
  }
  expect(host.querySelector(".animate-spin")).toBe(spinner!);
  // And the row still followed the message it is named by.
  expect(after[0]?.textContent).toContain("rework the sidebar");
});

test("switching moves the highlight without rebuilding the list", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  const before = [...host.querySelectorAll("li")];
  const spinner = host.querySelector(".animate-spin");

  store.ingest({
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
  flush();
  // The switch re-reads the listing, which answers with the same sessions.
  await Bun.sleep(0);
  flush();

  const after = [...host.querySelectorAll("li")];
  expect(after).toHaveLength(before.length);
  for (const [index, row] of after.entries()) {
    expect(row).toBe(before[index]!);
  }
  expect(host.querySelector(".animate-spin")).toBe(spinner!);
  expect(after[1]?.innerHTML).toContain("bg-neutral-850");
  expect(after[0]?.innerHTML).not.toContain("bg-neutral-850");
});
