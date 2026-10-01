import "./test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ServerEvent, SessionStatus } from "#protocol/ServerEvent";
import { Shell } from "./App";
import { baseName } from "./format";
import { SessionStore } from "./session/SessionStore";
import { Settings } from "./settings/Settings";
import { mountPoint } from "./test/dom";
import { GatewayHarness } from "./test/gateway";
import { until } from "#core/shared/fixtures/wait";
import { fakeViewport } from "./test/viewport";

function attached(sessionId = "s1"): ServerEvent {
  return {
    type: "attached",
    sessionId,
    cwd: "/repo",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  };
}

// Drafts persist in localStorage.
beforeEach(() => {
  localStorage.clear();
});

let realMatchMedia: typeof globalThis.matchMedia | undefined;
let fakedViewport: ReturnType<typeof fakeViewport> | undefined;

// A touch-only device; happy-dom otherwise answers media queries like a desktop.
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
  fakedViewport?.restore();
  fakedViewport = undefined;
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

// Stubs the upload fetch: the store is offline, but uploads are plain HTTP.
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

// True while pinned to the newest content.
function follows(scroller: HTMLElement): boolean {
  return scroller.classList.contains("[overflow-anchor:none]");
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
    const viewport = fakeViewport(800);
    fakedViewport = viewport;
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

    const composer = host.querySelector("textarea")!.closest("div")!;
    expect(composer.textContent).toContain("sonnet");
    expect(composer.textContent).toContain("medium");
    expect(host.textContent).toContain("$1.250");

    expect(host.textContent).not.toContain("tok/s");
    expect(host.textContent).not.toContain("streaming");

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
    expect(host.innerHTML).toContain("i-griddy-icons:file-edit");
    expect(
      host.querySelector('[aria-label^="Review changes"]')?.textContent
    ).toBe("3");
    expect(host.textContent).toContain("↑2");
    expect(host.textContent).toContain("↓1");

    const fill = [...host.querySelectorAll("div")].find((node) =>
      node.textContent?.startsWith("74.5%")
    )!;
    expect(fill.textContent).toBe("74.5%/1.0M");
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
    expect(host.textContent).not.toContain("*");
  });

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

    // The chip follows the server, not the keypress.
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
    const chip = (): HTMLElement =>
      host.querySelector<HTMLElement>("[title*='lank']")!;

    try {
      store.ingest(attached());
      store.ingest(state("thinking"));
      flush();

      now += 8_000;
      store.ingest({ type: "text_delta", messageId: "live-1", delta: "hi" });
      store.ingest(state("tool"));
      store.ingest(state("streaming"));
      flush();
      expect(chip().title).toStartWith("Clanking…");
      expect(chip().innerHTML).toContain("animate-spin");

      now += 1_000;
      store.ingest(state("idle"));
      flush();
      now += 60_000;
      store.ingest(state("idle"));
      flush();
      expect(chip().title).toBe("Clanked for 9s");
      expect(chip().innerHTML).toContain("i-griddy-icons:check");
      expect(chip().innerHTML).not.toContain("animate-spin");
    } finally {
      Date.now = real;
    }
  });

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

      store.ingest(attached("s2"));
      store.ingest(state("idle"));
      flush();
      expect(chip()).toBeNull();

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

  test("a turn already running is timed from where it started", () => {
    const store = offline();
    const host = paint(store);
    const chip = (): HTMLElement | null =>
      host.querySelector<HTMLElement>("[title*='lank']");
    const real = Date.now;
    let now = real();
    Date.now = () => now;

    try {
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

  test("an extension speaks in a panel when it was asked, and over the shell when it was not", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "ui_notice",
      id: "n1",
      severity: "info",
      text: "The cache finished warming.",
    });
    flush();

    expect(host.textContent).toContain("The cache finished warming.");
    expect(
      [...host.querySelectorAll("dialog")].some((found) => found.open)
    ).toBe(false);

    store.ingest({
      type: "ui_notice",
      id: "n2",
      severity: "info",
      text: "## Claude Quotas",
      command: "/claude-quota",
    });
    flush();

    const panel = [...host.querySelectorAll("dialog")].find(
      (found) => found.open
    );
    expect(panel?.getAttribute("aria-label")).toBe("/claude-quota");
    expect(panel?.querySelector("h2")?.textContent).toBe("Claude Quotas");
  });

  test("the box belongs to the session, and keeps what was left in it", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached("s1"));
    flush();
    const input = host.querySelector("textarea")!;
    type(input, "half a thought");

    store.ingest(attached("s2"));
    flush();
    expect(input.value).toBe("");
    type(input, "and something else");

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

    store.ingest(attached("s2"));
    flush();
    expect(host.querySelector("img[alt='shot.png']")).toBeNull();

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

    type(input, "hello");
    expect(press(input, "Enter").defaultPrevented).toBe(false);
    flush();
    expect(input.value).toBe("hello");

    expect(input.getAttribute("enterkeyhint")).toBe("enter");

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

    expect(host.querySelector('[aria-label="Stop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Steer"]')).toBeNull();

    const input = host.querySelector("textarea")!;
    type(input, "actually, use the other file");
    flush();
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull();
    const steer = host.querySelector<HTMLButtonElement>(
      '[aria-label="Steer"]'
    )!;
    steer.click();
    flush();
    expect(input.value).toBe("");
    expect(store.state.optimistic.map((one) => one.queued)).toEqual([true]);
    expect(host.textContent).toContain("Queued. Click to edit.");
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
    scroller.dispatchEvent(new Event("scroll"));
    flush();
    expect(follows(scroller)).toBe(false);

    const input = host.querySelector("textarea")!;
    const draft = "first line\nsecond line\nthird line\nfourth line";
    type(input, draft);
    press(input, "Enter");
    flush();

    expect(store.state.optimistic[0]?.text).toBe(draft);
    expect(input.value).toBe("");
    expect(scroller.scrollTop).toBe(0);
    expect(follows(scroller)).toBe(true);
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
    expect(follows(scroller)).toBe(true);
    expect(scroller.children).toHaveLength(2);
    expect(scroller.firstElementChild!.className).toContain("sticky");
    const content = scroller.lastElementChild!;
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

  test("reading back a way hands the position to scroll anchoring, and coming back takes it away", () => {
    const store = offline();
    const host = paint(store);
    store.ingest(attached());
    store.ingest(message(1, "earlier message"));
    flush();
    const scroller = scrollerOf(host);

    scroller.scrollTop = -120;
    scroller.dispatchEvent(new Event("scroll"));
    flush();
    expect(follows(scroller)).toBe(false);

    scroller.scrollTop = -8;
    scroller.dispatchEvent(new Event("scroll"));
    flush();
    expect(follows(scroller)).toBe(true);
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

    const list = () => host.querySelector('nav[aria-label="Sessions"]')!;
    await until(
      () => list().textContent.includes("say hello"),
      "the catalogue"
    );

    expect(list().querySelectorAll("h3 > button")).toHaveLength(1);
    expect(list().querySelector("h3 > button")?.textContent).toContain(
      baseName(harness.tmp)
    );
    expect(list().querySelectorAll("li").length).toBeGreaterThan(0);
    const scroller = scrollerOf(host);
    scroller.scrollTop = -500;
    list().querySelector<HTMLButtonElement>("li button")!.click();
    expect(scroller.scrollTop).toBe(0);
  });

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
            event.text.includes("greeter.ts:1") &&
            event.text.includes("move this to the trailing edge")
        ),
      "the one message carrying both halves"
    );
    flush();

    expect(chip(host)).toBeNull();
    expect(host.querySelector('section[aria-label="Changes"]')).toBeNull();
  });

  test("a plain message sent from the diff view brings the transcript back", async () => {
    seedComments(harness.tmp, "never mind");
    const host = paint(store);
    chip(host)!.click();
    flush();
    host
      .querySelector<HTMLButtonElement>('[aria-label="Discard the review"]')!
      .click();
    flush();
    expect(host.querySelector('section[aria-label="Changes"]')).not.toBeNull();

    const input = host.querySelector("textarea")!;
    type(input, "say hello");
    host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click();
    flush();

    expect(host.querySelector('section[aria-label="Changes"]')).toBeNull();
    await until(
      () =>
        store.state.durable.some(
          (event) =>
            event.type === "message" &&
            event.role === "user" &&
            event.text === "say hello"
        ),
      "the message"
    );
  });

  function queuedCard(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(
      '[aria-label="Edit queued message"]'
    );
  }

  // Holds a turn open with a queued message. The prompt must not use a tool:
  // pi delivers queued messages at tool boundaries.
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
    // The card shows on the gateway's ack, before pi has queued the message.
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

// Rows of the open popover; closed ones keep their lists mounted.
function options(host: HTMLElement): readonly Element[] {
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
