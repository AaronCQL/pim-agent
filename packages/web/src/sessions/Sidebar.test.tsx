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

import type { CommandDraft } from "#protocol/Command";
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

/** Out of the live listing: only the archived scope answers with it. */
const PUT_AWAY: SessionSummaryView = {
  sessionId: "cccccccc-3333",
  cwd: "/home/ada/dev/pim",
  createdAt: 0,
  settledAt: 0,
  title: "Put away last week",
  archived: true,
};

type Painted = {
  readonly host: HTMLElement;
  readonly switched: string[];
  readonly sent: CommandDraft[];
  readonly store: SessionStore;
};

/**
 * Offline: the listing is the only thing this reads, so it is the only thing
 * answered. Answered rather than stubbed away, because the marks it carries
 * are the server's and this is where the store takes them from. Every other
 * command is taken down, so a row's verbs can be read off the wire.
 */
function paint(
  options: {
    readonly onNavigate?: () => void;
    readonly onOpenSettings?: () => void;
    readonly unread?: readonly string[];
    readonly archived?: readonly SessionSummaryView[];
    /** What the server refuses every mutating command with. */
    readonly refuse?: string;
  } = {}
): Painted {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  const switched: string[] = [];
  const sent: CommandDraft[] = [];
  store.client.send = async (draft) => {
    sent.push(draft);
    if (draft.type === "list_sessions") {
      return {
        type: "response",
        id: "1",
        success: true,
        sessions:
          draft.archived === true
            ? (options.archived ?? [])
            : SESSIONS.map((session) => {
                // A real listing says what each session is doing, so this one
                // does too: the spinner is read off the status, and a row
                // answered for as idle would stop one mid-turn on the next
                // re-list.
                // Untracked: the server this stands in for is answering a
                // request, not deriving a value, and this runs from inside the
                // effect that asked.
                const status = untrack(
                  () => store.state.activity[session.sessionId]
                );
                return {
                  ...session,
                  ...((options.unread ?? []).includes(session.sessionId)
                    ? { unread: true }
                    : {}),
                  ...(status === undefined || status === "idle"
                    ? {}
                    : { status }),
                };
              }),
      };
    }
    return options.refuse === undefined
      ? { type: "response", id: "1", success: true }
      : { type: "response", id: "1", success: false, error: options.refuse };
  };
  store.switchTo = async (sessionId) => {
    switched.push(sessionId);
  };
  const host = mountPoint();
  render(
    () => (
      <Sidebar
        store={store}
        {...(options.onNavigate ? { onNavigate: options.onNavigate } : {})}
        {...(options.onOpenSettings
          ? { onOpenSettings: options.onOpenSettings }
          : {})}
      />
    ),
    host
  );
  flush();
  return { host, switched, sent, store };
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

/**
 * What a row is: the button that attaches to the session. The `⋯` beside it is
 * a button too, and so is the footer, so a bare `button` is three things now.
 */
function bodies(host: HTMLElement): readonly HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("li > button")];
}

function menu(host: HTMLElement, index = 0): HTMLButtonElement {
  return [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label^="Options for"]'),
  ][index]!;
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flush();
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flush();
}

/** Rows the reader can reach; a closed menu keeps no panel at all. */
function verbs(host: HTMLElement): readonly HTMLElement[] {
  const panel = [...host.querySelectorAll("[popover]")].find(
    (element) => !element.className.includes("hidden")
  );
  return panel === undefined
    ? []
    : [...panel.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** A verb commits before the caret moves, so it answers the press rather than the click. */
function choose(host: HTMLElement, label: string): void {
  const row = verbs(host).find((option) => option.textContent === label);
  expect(row).toBeDefined();
  row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  flush();
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
 * does not turn into a test that sees an empty list.
 */
async function listed(host: HTMLElement): Promise<void> {
  for (let hop = 0; hop < 20 && bodies(host).length === 0; hop += 1) {
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

test("one flat row per session: name, directory and how long ago", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
  // A session with nothing written to it yet has only its id for a name.
  expect(rows[1]?.textContent).toContain("bbbbbbbb");
  // The directory only; the full path is the row's tooltip.
  expect(rows[0]?.textContent).toContain("pim");
  expect(rows[0]?.textContent).not.toContain("~/dev/pim");
  expect(rows[0]?.querySelector('[title="~/dev/pim"]')).not.toBeNull();
  expect(rows[1]?.textContent).toContain("other");
});

test("the dot marks a session that has answered since anything read it", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();
  expect(host.querySelectorAll('[aria-label="Unread"]')).toHaveLength(0);

  const { host: marked, store } = paint({ unread: ["aaaaaaaa-1111"] });
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

/**
 * The session was started in the terminal, so nothing this browser did could
 * have made it ask for the list again. The server says the tree moved and the
 * row appears where the user is already looking.
 */
test("a session another process started arrives without being asked for", async () => {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  let sessions: readonly SessionSummaryView[] = SESSIONS;
  store.client.send = async () => ({
    type: "response",
    id: "1",
    success: true,
    sessions,
  });
  const host = mountPoint();
  render(() => <Sidebar store={store} />, host);
  flush();
  await listed(host);
  expect(host.querySelectorAll("li")).toHaveLength(2);

  sessions = [
    ...SESSIONS,
    {
      sessionId: "cccccccc-3333",
      cwd: "/home/ada/dev/pim",
      createdAt: 0,
      settledAt: 1,
      title: "Started in the terminal",
    },
  ];
  store.ingest({ type: "sessions_changed" });
  flush();
  for (let hop = 0; hop < 20 && host.querySelectorAll("li").length < 3; hop++) {
    await Promise.resolve();
    flush();
  }

  expect(host.textContent).toContain("Started in the terminal");
});

test("picking a row attaches to it and tells the host to get out of the way", async () => {
  const navigated: number[] = [];
  const { host, switched } = paint({ onNavigate: () => navigated.push(1) });
  await Bun.sleep(0);
  flush();

  click(bodies(host)[1]!);

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
    bodies(host)[0]?.querySelector("div:last-child > div:last-child")
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
  const { host } = paint({ onOpenSettings: () => opened.push(1) });
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
  // And nothing to rename, archive or hold unread: there is no file yet.
  expect(rows[0]?.querySelector('[aria-label^="Options for"]')).toBeNull();
  expect(rows[1]?.querySelector('[aria-label^="Options for"]')).not.toBeNull();
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

test("a name somebody wrote outranks the message the session opened with", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "session_meta",
    sessionId: "aaaaaaaa-1111",
    name: "String building",
  });
  flush();

  // Patched in place: the listing was not asked for again.
  expect(bodies(host)[0]?.textContent).toContain("String building");
  expect(bodies(host)[0]?.textContent).not.toContain(
    "Modernise the string building"
  );
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
    writable: true,
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
  // The fill is on the row's own button: the `⋯` beside it carries the same
  // colour as a hover, so the row is asked rather than its markup searched.
  expect(bodies(host)[1]?.className).toContain("bg-neutral-850");
  expect(bodies(host)[0]?.className).not.toContain("bg-neutral-850");
});

test("every row wears its `⋯` without being hovered", async () => {
  const { host } = paint();
  await listed(host);

  const triggers = host.querySelectorAll('[aria-label^="Options for"]');
  expect(triggers).toHaveLength(2);
  const trigger = menu(host);
  expect(trigger.innerHTML).toContain("i-griddy-icons:more-horizontal");
  // Dimmed, not hidden: a reveal on hover is nothing at all under a finger.
  expect(trigger.className).toContain("opacity-60");
  expect(trigger.className).not.toContain("opacity-0");
  expect(verbs(host)).toHaveLength(0);
});

test("the `⋯` and a right-click open the same three verbs", async () => {
  const { host } = paint();
  await listed(host);

  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Archive",
  ]);
  expect(menu(host).getAttribute("aria-expanded")).toBe("true");

  // Dismissed by a pointer landing anywhere else.
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flush();
  expect(verbs(host)).toHaveLength(0);

  bodies(host)[0]!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true })
  );
  flush();
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Archive",
  ]);
});

test("marking a row unread holds the dot without navigating anywhere", async () => {
  const navigated: number[] = [];
  const { host, sent, switched } = paint({
    onNavigate: () => navigated.push(1),
  });
  await listed(host);

  click(menu(host));
  choose(host, "Mark unread");

  expect(sent.at(-1)).toEqual({
    type: "set_session_unread",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });
  expect(
    host.querySelectorAll('li:first-child [aria-label="Unread"]')
  ).toHaveLength(1);
  // The drawer stays where it is: nothing here moved the reader.
  expect(navigated).toEqual([]);
  expect(switched).toEqual([]);
  // And the verb reads back the other way.
  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toContain(
    "Mark read"
  );
});

test("archiving takes the row off the live list", async () => {
  const { host, sent } = paint();
  await listed(host);
  expect(bodies(host)).toHaveLength(2);

  click(menu(host));
  choose(host, "Archive");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });
  // The menu goes with the verb it was opened for.
  expect(verbs(host)).toHaveLength(0);
  expect(bodies(host)).toHaveLength(1);
  expect(host.textContent).not.toContain("Modernise the string building");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("a refused archive puts the row back and says why", async () => {
  const { host } = paint({ refuse: "the session is open in the terminal" });
  await listed(host);

  click(menu(host));
  choose(host, "Archive");
  await Bun.sleep(0);
  flush();

  expect(bodies(host)).toHaveLength(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "the session is open in the terminal"
  );
});

test("the footer opens the archived listing, and a row comes back from it", async () => {
  const { host, sent } = paint({ archived: [PUT_AWAY] });
  await listed(host);
  expect(host.textContent).not.toContain("Put away last week");

  click(host.querySelector("[aria-pressed]")!);
  for (let hop = 0; hop < 20 && bodies(host).length !== 1; hop += 1) {
    await Promise.resolve();
    flush();
  }

  // A second listing, asked for by scope.
  expect(sent.at(-1)).toEqual({ type: "list_sessions", archived: true });
  expect(host.textContent).toContain("Put away last week");
  expect(host.textContent).not.toContain("Modernise the string building");
  expect(host.querySelector('[aria-pressed="true"]')).not.toBeNull();

  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Unarchive",
  ]);
  choose(host, "Unarchive");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "cccccccc-3333",
    value: false,
  });
  expect(host.textContent).not.toContain("Put away last week");
  expect(host.textContent).toContain("Nothing archived.");
});

test("the keyboard walks the menu and commits the row it stands on", async () => {
  const { host, sent } = paint();
  await listed(host);

  const trigger = menu(host);
  click(trigger);
  press(trigger, "ArrowDown");
  expect(verbs(host)[1]?.getAttribute("aria-selected")).toBe("true");
  press(trigger, "End");
  expect(verbs(host)[2]?.getAttribute("aria-selected")).toBe("true");
  press(trigger, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });

  click(menu(host));
  expect(verbs(host)).toHaveLength(3);
  press(menu(host), "Escape");
  expect(verbs(host)).toHaveLength(0);
});

test("Rename writes over the row, commits on Enter and gives up on Escape", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>(
      '[aria-label="Rename Modernise the string building"]'
    );
  expect(box()?.value).toBe("Modernise the string building");
  // It arrives with the caret in it, and with what is there already picked out.
  expect(document.activeElement).toBe(box());
  // The row it stands in for is gone while it is being named.
  expect(bodies(host)).toHaveLength(1);

  box()!.value = "Strings";
  press(box()!, "Escape");
  expect(box()).toBeNull();
  expect(bodies(host)).toHaveLength(2);
  expect(sent.some((command) => command.type === "set_session_name")).toBe(
    false
  );

  click(menu(host));
  choose(host, "Rename");
  box()!.value = "Strings";
  press(box()!, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_name",
    sessionId: "aaaaaaaa-1111",
    value: "Strings",
  });
  expect(box()).toBeNull();
});

test("a name cleared to nothing goes back to the message the session opened with", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box.value = "   ";
  press(box, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_name",
    sessionId: "aaaaaaaa-1111",
    value: null,
  });
});

test("a name left as it was says nothing to the server", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  press(box, "Enter");

  expect(sent.some((command) => command.type === "set_session_name")).toBe(
    false
  );
});
