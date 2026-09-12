import "./test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent, SessionStatus } from "#protocol/ServerEvent";
import { Shell } from "./App";
import { baseName } from "./format";
import { SessionStore } from "./session/SessionStore";
import { Settings } from "./settings/Settings";
import { mountPoint } from "./test/dom";
import { GatewayHarness, until } from "./test/gateway";

function attached(sessionId = "s1"): ServerEvent {
  return {
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    cwd: "/repo",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  };
}

// Each test is its own browser: a draft outlives a tab by design, so the
// storage it lives in must not outlive the test that wrote it.
beforeEach(() => {
  localStorage.clear();
});

let realMatchMedia: typeof globalThis.matchMedia | undefined;
const realVisualViewport = Object.getOwnPropertyDescriptor(
  globalThis,
  "visualViewport"
);

function resizableViewport(initialHeight: number): {
  readonly resize: (height: number) => void;
} {
  let height = initialHeight;
  const viewport = new EventTarget();
  Object.defineProperty(viewport, "height", { get: () => height });
  Object.defineProperty(globalThis, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  return {
    resize: (next) => {
      height = next;
      viewport.dispatchEvent(new Event("resize"));
    },
  };
}

/**
 * A device whose only keyboard is the one drawn over the page: no hover and
 * no fine pointer, and so no Shift+Enter for the composer to offer. happy-dom
 * answers every feature query like a desktop, which is the right default for
 * every other test here and has to be taken away for these.
 */
function softKeyboard(): void {
  realMatchMedia ??= globalThis.matchMedia;
  const real = realMatchMedia.bind(globalThis);
  globalThis.matchMedia = ((query: string) =>
    query.includes("hover")
      ? { matches: false, addEventListener() {}, removeEventListener() {} }
      : real(query)) as typeof globalThis.matchMedia;
}

afterEach(() => {
  if (realMatchMedia) {
    globalThis.matchMedia = realMatchMedia;
    realMatchMedia = undefined;
  }
  if (realVisualViewport) {
    Object.defineProperty(globalThis, "visualViewport", realVisualViewport);
  } else {
    Reflect.deleteProperty(globalThis, "visualViewport");
  }
});

function paint(store: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={store} settings={new Settings()} />, host);
  flush();
  return host;
}

function offline(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
}

/**
 * One upload, answered the way the gateway answers it. The store is offline
 * here — a socket it cannot open — but an upload is plain HTTP and goes out
 * whether or not the socket is up, so it is the fetch that has to be told
 * what the server would have said.
 */
async function attach(store: SessionStore, name: string): Promise<void> {
  const real = globalThis.fetch;
  const sessionId = store.state.sessionId;
  globalThis.fetch = (async () =>
    Response.json({
      id: `${sessionId}-${name}`,
      url: `/attachment/${sessionId}/${name}`,
      isImage: true,
    })) as unknown as typeof fetch;
  try {
    await store.attachFile(new File(["x"], name, { type: "image/png" }));
  } finally {
    globalThis.fetch = real;
  }
}

function scrollerOf(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>("div.overflow-y-auto")!;
}

function message(seq: number, text: string): ServerEvent {
  return {
    seq,
    type: "message",
    messageId: `u${seq}`,
    role: "user",
    text,
    timestamp: 0,
  };
}

describe("the shell, painted from events alone", () => {
  test("fits inside the visual viewport when the software keyboard opens", () => {
    const viewport = resizableViewport(800);
    const host = paint(offline());
    const shell = host.querySelector("main")!;
    expect(shell.style.height).toBe("800px");

    viewport.resize(460);
    flush();
    expect(shell.style.height).toBe("460px");
  });

  test("a new session opens with the basic controls", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    flush();
    const splash = host.querySelector<HTMLElement>(
      "[aria-label='Pim controls']"
    )!;
    expect(splash.textContent).toContain("PIM - Pi IMproved");
    expect(splash.textContent).toContain("Escape");
    expect(splash.textContent).toContain("/<command>");
    expect(splash.textContent).toContain("@<path>");
    expect(splash.textContent).toContain("Ctrl/⌘ + Enter");
    const splashViewport = splash.parentElement!;
    const emptyStack = splashViewport.parentElement!;
    const emptyState = emptyStack.parentElement!;
    expect(splashViewport.className).toContain("min-h-0");
    expect(splashViewport.className).toContain("overflow-hidden");
    expect(emptyStack.className).toContain("max-h-full");
    expect(emptyStack.lastElementChild?.className).toContain("shrink-0");
    expect(emptyState.className).toContain("inset-0");

    const composer = host.querySelector("textarea")!;
    type(composer, "hello");
    flush();
    expect(host.querySelector("[aria-label='Pim controls']")).toBe(splash);
    expect(host.querySelector("textarea")).toBe(composer);

    store.ingest(message(2, "hello"));
    flush();
    expect(host.querySelector("[aria-label='Pim controls']")).toBeNull();
    expect(host.querySelector("textarea")).toBe(composer);
  });

  test("paints the streaming turn and then the durable message", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      seq: 2,
      type: "message",
      messageId: "u1",
      role: "user",
      text: "hello",
      timestamp: 0,
    });
    store.ingest({
      type: "message_start",
      role: "assistant",
      messageId: "live-1",
    });
    store.ingest({ type: "text_delta", messageId: "live-1", delta: "## Do" });
    flush();
    expect(host.textContent).toContain("hello");

    store.ingest({ type: "text_delta", messageId: "live-1", delta: "ne\n\n" });
    flush();
    expect(host.querySelector(".pim-markdown h2")?.textContent).toBe("Done");

    store.ingest({
      seq: 3,
      type: "message",
      messageId: "a1",
      role: "assistant",
      text: "## Done\n",
      timestamp: 0,
    });
    store.ingest({ type: "message_retire", messageId: "live-1" });
    flush();
    expect(host.querySelectorAll(".pim-markdown h2")).toHaveLength(1);
  });

  test("what the footer used to say is spread across its new homes", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 1.25,
      status: "streaming",
      tps: 30.4,
      turnElapsedMs: 2_000,
    });
    flush();

    // Model, thinking and cost are the composer's chips and pill.
    const composer = host.querySelector("textarea")!.closest("div")!;
    expect(composer.textContent).toContain("sonnet");
    expect(composer.textContent).toContain("medium");
    expect(host.textContent).toContain("$1.250");

    // Dropped with the footer: the status word, tok/s and the seq readout.
    expect(host.textContent).not.toContain("tok/s");
    expect(host.textContent).not.toContain("streaming");

    // The clank chip is the only running indicator.
    expect(host.textContent).toContain("Clanking…");
  });

  test("the topbar chips say where and what, and the context fill is half the pill", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/home/ada/src/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0.5,
      status: "idle",
      contextPercent: 74.5,
      contextWindow: 1_000_000,
      branch: "feat/new-stuff",
      dirtyCount: 3,
      ahead: 2,
      behind: 1,
    });
    flush();

    expect(host.innerHTML).toContain("i-griddy-icons:folder");
    expect(host.textContent).toContain("~/src/repo");
    expect(host.innerHTML).toContain("i-griddy-icons:code-branch");
    expect(host.textContent).toContain("feat/new-stuff");
    // Dirt is a count, not a flag, and divergence rides along beside it.
    expect(host.textContent).toContain("*3");
    expect(host.textContent).toContain("↑2");
    expect(host.textContent).toContain("↓1");

    const fill = [...host.querySelectorAll("div")].find((node) =>
      node.textContent?.startsWith("74.5%")
    )!;
    expect(fill.textContent).toBe("74.5%/1.0M");
    // Past the TUI footer's own 70, so it reads as full rather than as fine.
    expect(fill.className).toContain("text-rose-400");
  });

  test("outside a repository there is no branch chip at all", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "idle",
    });
    flush();

    expect(host.innerHTML).not.toContain("code-branch");
    // A clean tree says nothing rather than saying zero.
    expect(host.textContent).not.toContain("*");
  });

  /**
   * The chip names the model the way the menu does. The id is what a switch
   * is sent as, and a server that has not resolved a name yet leaves it as
   * the only thing there is to say.
   */
  test("the model chip says the model's name, falling back to its id", () => {
    const store = offline();
    const host = paint(store);
    const state = (modelLabel?: string): ServerEvent => ({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "anthropic/claude-opus-5",
      ...(modelLabel === undefined ? {} : { modelLabel }),
      thinking: "medium",
      cost: 0,
      status: "idle",
    });

    store.ingest(attached());
    store.ingest(state("Claude Opus 5.0"));
    flush();
    expect(host.textContent).toContain("Claude Opus 5.0");
    expect(host.textContent).not.toContain("anthropic/claude-opus-5");

    store.ingest(state());
    flush();
    expect(host.textContent).toContain("anthropic/claude-opus-5");
  });

  /**
   * The TUI's own gesture, on the key the fingers already use for it. The
   * catalogue is the server's, so the step is up the order the menu reads,
   * and the chip only changes once the server says the level did.
   */
  test("Shift+Tab in the box steps the thinking level and wraps", async () => {
    const store = offline();
    const asked: string[] = [];
    store.client.send = (async (command: {
      readonly type: string;
      readonly value?: string;
    }) => {
      if (command.type === "set_thinking" && command.value !== undefined) {
        asked.push(command.value);
      }
      return {
        type: "response",
        id: "1",
        success: true,
        models: [],
        thinkingLevels: ["off", "medium", "high"],
      };
    }) as typeof store.client.send;
    const host = paint(store);
    store.ingest(attached());
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "idle",
    });
    flush();
    const input = host.querySelector("textarea")!;

    expect(press(input, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    await until(() => asked.length === 1, "the level after medium");
    expect(asked).toEqual(["high"]);

    // The chip follows the server, not the keypress: until a state frame
    // says otherwise the session is still thinking at the old level, and the
    // next step is measured from that.
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "high",
      cost: 0,
      status: "idle",
    });
    flush();
    press(input, "Tab", { shiftKey: true });
    await until(() => asked.length === 2, "the wrap back to the first level");
    expect(asked).toEqual(["high", "off"]);
  });

  test("the clank chip times the whole turn, not the last thing in it", () => {
    const store = offline();
    const host = paint(store);
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    // As the server says it: a state frame about a working agent dates the
    // turn it is working on, so the client never has to guess.
    const started = now;
    const state = (status: SessionStatus): ServerEvent => ({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status,
      ...(status === "idle" ? {} : { turnElapsedMs: now - started }),
    });
    // The whole reading lives in the chip's title, words and all, because a
    // narrow screen drops the words from the pill itself.
    const chip = (): HTMLElement =>
      host.querySelector<HTMLElement>("[title*='lank']")!;

    try {
      store.ingest(attached());
      store.ingest(state("thinking"));
      flush();

      // A turn is a run of statuses, and each one of them wakes the clock's
      // effect; none of them is a new turn.
      now += 8_000;
      store.ingest({ type: "text_delta", messageId: "live-1", delta: "hi" });
      store.ingest(state("tool"));
      store.ingest(state("streaming"));
      flush();
      // The reading itself only moves on the interval, which is a real timer
      // and has not fired; what is asserted here is the running state.
      expect(chip().title).toStartWith("Clanking…");
      expect(chip().innerHTML).toContain("animate-spin");

      // Idle settles the reading, and idle again — a branch poll, say — must
      // not carry on adding to it.
      now += 1_000;
      store.ingest(state("idle"));
      flush();
      now += 60_000;
      store.ingest(state("idle"));
      flush();
      expect(chip().title).toBe("Clanked for 9s");
      // Settled reads as a tick where running read as the spun ring.
      expect(chip().innerHTML).toContain("i-griddy-icons:check");
      expect(chip().innerHTML).not.toContain("animate-spin");
    } finally {
      Date.now = real;
    }
  });

  /**
   * The chip is mounted once and every session borrows it, so its reading
   * has to be the attached session's own: a new chat has clanked for
   * nothing, and one switched *to* is timed by its own log rather than by
   * whatever was on screen a moment ago.
   */
  test("the clank reading does not follow the reader to another session", () => {
    const store = offline();
    const host = paint(store);
    const chip = (): HTMLElement | null =>
      host.querySelector<HTMLElement>("[title*='lank']");
    const real = Date.now;
    let now = real();
    Date.now = () => now;
    const started = now;
    const state = (status: SessionStatus): ServerEvent => ({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status,
      ...(status === "idle" ? {} : { turnElapsedMs: now - started }),
    });

    try {
      store.ingest(attached("s1"));
      store.ingest(state("thinking"));
      flush();
      now += 12_000;
      store.ingest(state("idle"));
      flush();
      expect(chip()?.title).toBe("Clanked for 12s");

      // A brand-new chat: nothing has run in it, so there is nothing to say.
      store.ingest(attached("s2"));
      store.ingest(state("idle"));
      flush();
      expect(chip()).toBeNull();

      // And one with a turn behind it reads that turn off its own log.
      store.ingest(attached("s3"));
      store.ingest({
        seq: 1,
        type: "message",
        messageId: "u1",
        role: "user",
        text: "go",
        timestamp: 1_000,
      });
      store.ingest({
        seq: 2,
        type: "message",
        messageId: "a1",
        role: "assistant",
        text: "done",
        timestamp: 6_000,
      });
      store.ingest(state("idle"));
      flush();
      expect(chip()?.title).toBe("Clanked for 5s");
    } finally {
      Date.now = real;
    }
  });

  /**
   * Walking in on a running turn: only the process running it knows when it
   * began, so it says so, and the chip times from there rather than from the
   * moment the reader arrived — and says nothing at all until it has been
   * told, rather than starting at zero and correcting itself on screen.
   */
  test("a turn already running is timed from where it started", () => {
    const store = offline();
    const host = paint(store);
    const chip = (): HTMLElement | null =>
      host.querySelector<HTMLElement>("[title*='lank']");
    const real = Date.now;
    let now = real();
    Date.now = () => now;

    try {
      // The listing knows this session is working a round trip before the
      // server says since when, and a turn of unknown age is not a turn that
      // has run for nothing.
      store.ingest({
        type: "session_activity",
        sessionId: "s1",
        status: "tool",
      });
      store.ingest(attached("s1"));
      flush();
      expect(store.isBusy()).toBe(true);
      expect(chip()).toBeNull();

      store.ingest({
        type: "session_state",
        writable: true,
        cwd: "/repo",
        model: "sonnet",
        thinking: "medium",
        cost: 0,
        status: "tool",
        turnElapsedMs: 90_000,
      });
      flush();
      expect(chip()?.title).toBe("Clanking… 1m 30s");

      // From there it is this client's own clock: the reading grows by what
      // passed here, on top of what it was handed.
      now += 5_000;
      store.ingest({
        type: "session_state",
        writable: true,
        cwd: "/repo",
        model: "sonnet",
        thinking: "medium",
        cost: 0,
        status: "idle",
      });
      flush();
      expect(chip()?.title).toBe("Clanked for 1m 35s");
    } finally {
      Date.now = real;
    }
  });

  test("a session being fetched is a skeleton, not a half-painted log", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      seq: 2,
      type: "message",
      messageId: "u1",
      role: "user",
      text: "the session being left",
      timestamp: 0,
    });
    flush();

    store.client.attachTo = async () => ({
      type: "response",
      id: "1",
      success: true,
    });
    void store.switchTo("s2");
    flush();
    // The transcript alone: the sidebar goes on naming the session that was
    // left, which is the point of a sidebar.
    const transcript = host.querySelector("div.overflow-y-auto")!;
    expect(transcript.textContent).not.toContain("the session being left");

    store.ingest(attached("s2"));
    store.ingest({
      seq: 2,
      type: "message",
      messageId: "u2",
      role: "user",
      text: "the session being opened",
      timestamp: 0,
    });
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
    });
    flush();
    expect(host.textContent).toContain("the session being opened");
  });

  test("an error is a rose line above the composer", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({ type: "error", message: "provider said no" });
    flush();

    expect(host.textContent).toContain("provider said no");
  });

  test("the box belongs to the session, and keeps what was left in it", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached("s1"));
    flush();
    const input = host.querySelector("textarea")!;
    type(input, "half a thought");

    // Another session is another box: this one has never been typed into.
    store.ingest(attached("s2"));
    flush();
    expect(input.value).toBe("");
    type(input, "and something else");

    // And back, to the message exactly as it was left.
    store.ingest(attached("s1"));
    flush();
    expect(input.value).toBe("half a thought");
    expect(store.draftText("s2")).toBe("and something else");
  });

  test("the files in the box belong to the session, like the words do", async () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached("s1"));
    flush();
    await attach(store, "shot.png");
    flush();
    expect(host.querySelector("img[alt='shot.png']")).not.toBeNull();

    // Away, where it is another session's business and not on screen...
    store.ingest(attached("s2"));
    flush();
    expect(host.querySelector("img[alt='shot.png']")).toBeNull();

    // ...and back, to the picture still waiting to be sent. The server is
    // holding those bytes under this session, so the id still names them.
    store.ingest(attached("s1"));
    flush();
    expect(host.querySelector("img[alt='shot.png']")).not.toBeNull();
  });

  test("a file can be taken back off the message before it is sent", async () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached("s1"));
    flush();
    await attach(store, "shot.png");
    flush();

    host
      .querySelector<HTMLButtonElement>("[aria-label='Remove shot.png']")!
      .click();
    flush();

    expect(host.querySelector("img[alt='shot.png']")).toBeNull();
    expect(store.attachmentsOf("s1")).toEqual([]);
  });

  // Drop and paste are the only other ways in, and neither is visible: a
  // phone cannot drag and nobody guesses at a gesture.
  test("the attach button reaches the file dialogue", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached("s1"));
    flush();
    const chooser = host.querySelector<HTMLInputElement>("input[type=file]")!;
    let opened = 0;
    chooser.click = () => {
      opened += 1;
    };

    host
      .querySelector<HTMLButtonElement>("[aria-label='Attach files']")!
      .click();

    expect(opened).toBe(1);
  });

  test("Enter sends where Shift+Enter exists to type the newline", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    flush();
    const input = host.querySelector("textarea")!;

    type(input, "hello");
    press(input, "Enter", { shiftKey: true });
    expect(input.value).toBe("hello");

    press(input, "Enter");
    flush();
    expect(input.value).toBe("");
  });

  test("on a soft keyboard Enter is the newline and a modifier is the send", () => {
    softKeyboard();
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    flush();
    const input = host.querySelector("textarea")!;

    // Left to the browser, which is what puts the second line in the box.
    type(input, "hello");
    expect(press(input, "Enter").defaultPrevented).toBe(false);
    flush();
    expect(input.value).toBe("hello");

    // The key is drawn from this hint, so it must not read "send" either.
    expect(input.getAttribute("enterkeyhint")).toBe("enter");

    // An external keyboard on the same device still has a way through.
    press(input, "Enter", { metaKey: true });
    flush();
    expect(input.value).toBe("");
  });

  test("the send button sends what Enter no longer does", () => {
    softKeyboard();
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    flush();
    const input = host.querySelector("textarea")!;
    type(input, "hello");

    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    // The press before the click keeps the box focused, so the soft keyboard
    // does not retract and slide the button out from under the finger.
    const tap = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    send.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(true);

    send.click();
    flush();
    expect(input.value).toBe("");
  });

  test("the one button is stop on an empty box and steer on a typed one", () => {
    softKeyboard();
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    store.ingest({
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "tool",
    });
    flush();

    // Nothing to send, so the running turn is the only thing the button can
    // mean — and it is one button, never a destructive one beside it.
    expect(host.querySelector('[aria-label="Stop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Steer"]')).toBeNull();

    const input = host.querySelector("textarea")!;
    type(input, "actually, use the other file");
    flush();
    // A phone's only way to say anything is this button, so typing takes it
    // back from stop; otherwise steering would be keyboard-only.
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull();
    const steer = host.querySelector<HTMLButtonElement>(
      '[aria-label="Steer"]'
    )!;
    steer.click();
    flush();
    expect(input.value).toBe("");
    expect(store.state.optimistic.map((one) => one.queued)).toEqual([true]);
    expect(host.textContent).toContain("Queued. Click to edit.");
    // The box is empty again, so the button goes back to being the turn's.
    expect(host.querySelector('[aria-label="Stop"]')).not.toBeNull();
  });

  test("sending jumps to the bottom origin", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    store.ingest(message(1, "earlier message"));
    flush();

    const scroller = scrollerOf(host);
    scroller.scrollTop = -500;

    const input = host.querySelector("textarea")!;
    const draft = "first line\nsecond line\nthird line\nfourth line";
    type(input, draft);
    press(input, "Enter");
    flush();

    expect(store.state.optimistic[0]?.text).toBe(draft);
    expect(input.value).toBe("");
    expect(scroller.scrollTop).toBe(0);
  });

  test("the bottom-origin layout keeps messages in chronological DOM order", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    store.ingest(message(1, "first message"));
    store.ingest(message(2, "second message"));
    flush();
    const scroller = scrollerOf(host);
    expect(scroller.classList.contains("flex")).toBe(true);
    expect(scroller.classList.contains("flex-col-reverse")).toBe(true);
    expect(scroller.children).toHaveLength(1);
    const content = scroller.firstElementChild!;
    expect(content.classList.contains("flex-none")).toBe(true);
    expect(content.classList.contains("min-h-full")).toBe(true);
    expect(
      [...content.querySelectorAll("article p")].map((p) => p.textContent)
    ).toEqual(["first message", "second message"]);
  });

  test("new messages do not write the reader's scroll position", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    const scroller = scrollerOf(host);

    store.ingest(message(2, "hello"));
    flush();

    scroller.scrollTop = -120;
    scroller.dispatchEvent(new Event("scroll"));

    store.ingest(message(3, "and the next one"));
    flush();
    expect(scroller.scrollTop).toBe(-120);
  });
});

describe("the composer, against a real gateway", () => {
  let harness: GatewayHarness;
  let store: SessionStore;

  beforeEach(async () => {
    harness = new GatewayHarness();
    await harness.start();
    await Bun.write(`${harness.tmp}/greeter.ts`, "export const x = 1;\n");
    store = new SessionStore({
      url: harness.url,
      cwd: harness.tmp,
      pickerDebounceMs: 0,
    });
    await store.connect();
  });

  afterEach(async () => {
    store.dispose();
    await harness.stop();
  });

  test("typing `@` queries the server and Enter completes the token", async () => {
    const host = paint(store);
    const input = host.querySelector("textarea")!;

    type(input, "look at @gre");
    await until(() => options(host).length > 0, "the server's answer");
    expect(options(host)[0]?.textContent).toContain("greeter.ts");

    press(input, "Enter");
    flush();
    expect(input.value).toBe("look at @greeter.ts");
    expect(options(host)).toHaveLength(0);
  });

  test("ESC closes the picker without touching the draft", async () => {
    const host = paint(store);
    const input = host.querySelector("textarea")!;

    type(input, "@gre");
    await until(() => options(host).length > 0, "the server's answer");

    press(input, "Escape");
    flush();
    expect(input.value).toBe("@gre");
    expect(options(host)).toHaveLength(0);
  });

  test("the sidebar lists sessions and picking one jumps to its end", async () => {
    const host = paint(store);
    await store.prompt("say hello");
    await until(
      () => store.state.durable.length > 0,
      "the durable user message"
    );

    const list = () => host.querySelector("ul")!;
    await until(
      // A session is named by its opening message, not by its id.
      () => list().textContent.includes("say hello"),
      "the catalogue"
    );

    // Flat, most recent first, the directory on every row — no grouping by it.
    expect(list().textContent).toContain(baseName(harness.tmp));
    expect(list().querySelectorAll("li").length).toBeGreaterThan(0);
    const scroller = scrollerOf(host);
    scroller.scrollTop = -500;
    list().querySelector<HTMLButtonElement>("li button")!.click();
    expect(scroller.scrollTop).toBe(0);
  });

  /** What another sitting of this browser left against the working copy. */
  function seedComments(cwd: string, ...texts: readonly string[]): void {
    localStorage.setItem(
      "pim.diff.comments",
      JSON.stringify({
        [cwd]: texts.map((text, at) => ({
          id: `c${at}`,
          path: "greeter.ts",
          side: "new",
          start: at + 1,
          end: at + 1,
          quote: "export const x = 1;",
          fingerprint: "f1",
          text,
          createdAt: at,
        })),
      })
    );
  }

  function chip(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(
      '[aria-label="Read the review"]'
    );
  }

  test("a pending review rides the composer and is discarded from it", () => {
    seedComments(harness.tmp, "move this", "and split that");
    const host = paint(store);

    expect(chip(host)?.textContent).toBe("2 comments");
    expect(host.querySelector('section[aria-label="Changes"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>('[aria-label="Discard the review"]')!
      .click();
    flush();
    expect(chip(host)).toBeNull();
  });

  test("the chip opens the review, and sending it leaves review mode empty-handed", async () => {
    seedComments(harness.tmp, "move this to the trailing edge");
    const host = paint(store);
    expect(chip(host)?.textContent).toBe("1 comment");

    chip(host)!.click();
    flush();
    expect(host.querySelector('section[aria-label="Changes"]')).not.toBeNull();

    const input = host.querySelector("textarea")!;
    type(input, "have a look");
    host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click();
    await until(
      () =>
        store.state.durable.some(
          (event) =>
            event.type === "message" &&
            event.role === "user" &&
            event.text.includes("have a look") &&
            event.text.includes("greeter.ts:1 (new)") &&
            event.text.includes("move this to the trailing edge")
        ),
      "the one message carrying both halves"
    );
    flush();

    expect(chip(host)).toBeNull();
    expect(host.querySelector('section[aria-label="Changes"]')).toBeNull();
  });

  /** Everything this client has said and not yet had heard, as one string. */
  function queuedCard(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
  }

  /**
   * A turn held open with a message waiting behind it, and the box painted.
   *
   * The prompt must not ask for a tool. pi hands its steering queue to the
   * turn at a turn boundary, and a tool result is one — so a message queued
   * while the tool ran would be delivered rather than held, and there would
   * be nothing left for these tests to take back. Parked on the gate mid
   * stream there is no next boundary until `release`, so what is queued
   * stays queued.
   */
  async function withQueued(waiting: string): Promise<{
    readonly host: HTMLElement;
    readonly input: HTMLTextAreaElement;
    readonly release: () => void;
  }> {
    const host = paint(store);
    const release = harness.holdTurn();
    await store.prompt("hold this turn open");
    await until(() => store.isBusy(), "the turn to start");
    await store.prompt(waiting);
    // The card above is painted on the gateway's ack, which means it took the
    // message — not that pi is holding it yet. Reclaiming it reads pi's queue,
    // so a test that clicks the card the moment it appears can beat the
    // message into that queue and get nothing back.
    await until(
      () => harness.pending(store.state.sessionId) === 1,
      "pi to be holding the queued message"
    );
    flush();
    return { host, input: host.querySelector("textarea")!, release };
  }

  test("a queued card goes back in the box when it is clicked", async () => {
    const { host, input, release } = await withQueued("and the weather");
    try {
      expect(queuedCard(host)?.textContent).toContain("and the weather");

      queuedCard(host)!.click();
      await until(
        () => input.value === "and the weather",
        "the message to come back to the box"
      );
      flush();
      // It is being edited now, so it is no longer waiting to be said — and
      // the turn it was waiting behind is still running.
      expect(queuedCard(host)).toBeNull();
      expect(store.isBusy()).toBe(true);
    } finally {
      release();
    }
  });

  test("Escape stops the turn and hands the queue back, box or no box", async () => {
    const { host, input, release } = await withQueued("and the weather");
    try {
      type(input, "one more thing");
      // A typed box no longer hides the stop: the turn is what Escape means,
      // and what pi was holding lands above what was being written.
      press(input, "Escape");
      await until(
        () => input.value.startsWith("and the weather"),
        "the queue to come back to the box"
      );
      expect(input.value).toBe("and the weather\n\none more thing");
      flush();
      expect(queuedCard(host)).toBeNull();
      await until(() => !store.isBusy(), "the turn to stop");
    } finally {
      release();
    }
  });
});

/** Rows the user can actually see; a closed popover keeps its list mounted. */
function options(host: HTMLElement): readonly Element[] {
  // The composer holds three popovers now — the picker and the two chip
  // menus — and only an open one has any rows the reader can reach.
  const panel = [...host.querySelectorAll("[popover]")].find(
    (element) => !element.className.includes("hidden")
  );
  if (panel === undefined) {
    return [];
  }
  return [...panel.querySelectorAll('[role="option"]')];
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function press(
  input: HTMLTextAreaElement,
  key: string,
  modifiers: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  input.dispatchEvent(event);
  return event;
}
