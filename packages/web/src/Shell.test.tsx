import "./test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent, SessionStatus } from "#protocol/ServerEvent";
import { Shell } from "./App";
import { SessionStore } from "./session/SessionStore";
import { mountPoint } from "./test/dom";
import { GatewayHarness, until } from "./test/gateway";

function attached(sessionId = "s1"): ServerEvent {
  return {
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    cwd: "/repo",
    head: 0,
  };
}

// Each test is its own browser: a draft outlives a tab by design, so the
// storage it lives in must not outlive the test that wrote it.
beforeEach(() => {
  localStorage.clear();
});

let realMatchMedia: typeof globalThis.matchMedia | undefined;

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
});

function paint(store: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={store} />, host);
  flush();
  return host;
}

function offline(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
}

/**
 * The transcript's scroller, with a layout happy-dom will not compute: a page
 * of viewport over a body of content whose height the caller can grow, which
 * is what a row taller than the flush that appended it looks like from here.
 */
function scrollerOf(host: HTMLElement): {
  readonly element: HTMLElement;
  grow: (height: number) => void;
} {
  // The sidebar's list scrolls too; the transcript's scroller is the one
  // holding it.
  const element = host.querySelector<HTMLElement>("div.overflow-y-auto")!;
  let height = 1000;
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  Object.defineProperty(element, "clientHeight", { value: 500 });
  return {
    element,
    grow: (by) => {
      height += by;
    },
  };
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
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 1.25,
      status: "streaming",
      tps: 30.4,
    });
    flush();

    // Model, thinking and cost are the composer's chips and pill.
    const composer = host.querySelector("textarea")!.closest("div")!;
    expect(composer.textContent).toContain("sonnet");
    expect(composer.textContent).toContain("medium");
    expect(host.textContent).toContain("$1.250");

    // The connection is the sidebar's server row, tinted rather than spelled.
    expect(host.textContent).toContain("127.0.0.1:1");
    expect(host.innerHTML).toContain("text-rose-400");

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
    expect(host.textContent).toContain("●3");
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
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "idle",
    });
    flush();

    expect(host.innerHTML).not.toContain("code-branch");
    // A clean tree says nothing rather than saying zero.
    expect(host.textContent).not.toContain("●");
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

  test("the clank chip times the whole turn, not the last thing in it", () => {
    const store = offline();
    const host = paint(store);
    const state = (status: SessionStatus): ServerEvent => ({
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status,
    });
    const real = Date.now;
    let now = real();
    Date.now = () => now;
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

  test("sending re-pins the transcript to its end", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());

    // happy-dom lays nothing out, so the scroller is given a page worth of
    // content to have scrolled away from.
    const { element: scroller } = scrollerOf(host);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));

    const input = host.querySelector("textarea")!;
    type(input, "hello");
    press(input, "Enter");
    flush();

    expect(scroller.scrollTop).toBe(1000);
  });

  test("a transcript that grows under its own scroll stays pinned", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    const { element: scroller, grow } = scrollerOf(host);

    store.ingest(message(2, "hello"));
    flush();
    expect(scroller.scrollTop).toBe(1000);

    // Markdown parses, a code block grows a copy button: the row is taller
    // than it was when the scroll above was written, and the browser delivers
    // that scroll now, against the taller transcript. Read as distance from
    // the end, this is a reader who has scrolled up; it is not one.
    grow(600);
    scroller.dispatchEvent(new Event("scroll"));

    store.ingest(message(3, "and the next one"));
    flush();
    expect(scroller.scrollTop).toBe(1600);
  });

  test("a reader who scrolls up is left where they are", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    const { element: scroller } = scrollerOf(host);

    store.ingest(message(2, "hello"));
    flush();

    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll"));

    store.ingest(message(3, "and the next one"));
    flush();
    expect(scroller.scrollTop).toBe(120);
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

  test("the sidebar lists the sessions pi has on disk", async () => {
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

    // Flat, most recent first, cwd on every row — no grouping by directory.
    expect(list().textContent).toContain(harness.tmp);
    expect(list().querySelectorAll("li").length).toBeGreaterThan(0);
  });

  /** Everything this client has said and not yet had heard, as one string. */
  function queuedCard(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
  }

  /** A turn held open with a message waiting behind it, and the box painted. */
  async function withQueued(waiting: string): Promise<{
    readonly host: HTMLElement;
    readonly input: HTMLTextAreaElement;
    readonly release: () => void;
  }> {
    const host = paint(store);
    const release = harness.holdTurn();
    await store.prompt("use a tool please");
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
