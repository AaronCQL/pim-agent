import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import {
  CHILD_PATCH_LINE,
  GatewayHarness,
  SUBAGENT_ANSWER,
  SUBAGENT_CALL_ID,
  SUBAGENT_PROMPT,
  until,
} from "../test/gateway";

/**
 * The modal, against the real gateway: a subagent that leaves a child log,
 * watched over the wire and painted by the transcript component the
 * conversation itself uses. Nothing here is a fixture of the protocol — the
 * envelope, the projection and the live drain are all the shipped ones.
 */

let harness: GatewayHarness;
let store: SessionStore;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  store = await connect();
});

afterEach(async () => {
  store.dispose();
  await harness.stop();
});

function connect(sessionId?: string): Promise<SessionStore> {
  const opened = new SessionStore({
    url: harness.url,
    cwd: harness.tmp,
    pickerDebounceMs: 0,
    backoffMs: () => 0,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return opened.connect().then(() => opened);
}

function paint(target: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={target} />, host);
  flush();
  return host;
}

function modal(host: HTMLElement): HTMLDialogElement {
  return host.querySelector<HTMLDialogElement>(
    "dialog[aria-label='Subagent']"
  )!;
}

/** The row's way in, which Phase 4 replaces with the card itself. */
function opener(host: HTMLElement): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open transcript"
    ) ?? null
  );
}

/** The child's log as the store holds it: what the modal is painted from. */
function childTexts(): readonly string[] {
  return (store.state.subagent?.events ?? []).flatMap((event) =>
    event.type === "message" ? [event.text] : []
  );
}

/** Delegates, and waits for the parent's row to offer the way in. */
async function delegate(host: HTMLElement): Promise<void> {
  await store.prompt("delegate this");
  await until(() => opener(host) !== null, "the subagent row");
}

async function open(host: HTMLElement): Promise<void> {
  opener(host)!.click();
  await until(
    () => childTexts().includes(SUBAGENT_PROMPT),
    "the child's prompt"
  );
  flush();
}

/** The turn finished: the call is written down and the agent is idle. */
function settled(): boolean {
  return (
    !store.isBusy() &&
    store.state.durable.some(
      (event) =>
        event.type === "tool_result" && event.callId === SUBAGENT_CALL_ID
    )
  );
}

/**
 * The modal's scroller, with a layout happy-dom will not compute: a page of
 * viewport over a body of content taller than it.
 */
function scrollerOf(dialog: HTMLDialogElement): HTMLElement {
  const element = dialog.querySelector<HTMLElement>("div.overflow-y-auto")!;
  Object.defineProperty(element, "scrollHeight", { get: () => 1000 });
  Object.defineProperty(element, "clientHeight", { value: 500 });
  return element;
}

/** One more entry in the child's log, as the envelope that carries them. */
function grow(seq: number, text: string): void {
  store.ingest({
    type: "subagent_events",
    callId: SUBAGENT_CALL_ID,
    events: [
      {
        seq,
        type: "message",
        messageId: `child-${seq}`,
        role: "assistant",
        text,
        timestamp: 0,
      },
    ],
  });
  flush();
}

test("a settled child opens onto its whole run, diffs and all", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");

  await open(host);

  const dialog = modal(host);
  expect(dialog.open).toBe(true);
  // The prompt reads as the child's user message because it is one, and the
  // answer as an assistant message, both out of the child's own log.
  expect(dialog.textContent).toContain(SUBAGENT_PROMPT);
  expect(dialog.textContent).toContain(SUBAGENT_ANSWER);

  // The child's own tool call is an ordinary row, and expanding it gives the
  // whole payload — the thing a one-line roster in the parent cannot carry.
  const disclosure = dialog.querySelector("details")!;
  expect(disclosure.textContent).toContain("src/config.ts");
  expect(disclosure.open).toBe(false);
  disclosure.querySelector("summary")!.click();
  flush();
  expect(disclosure.open).toBe(true);
  expect(dialog.textContent).toContain(CHILD_PATCH_LINE);
  // Painted as a diff rather than as quoted text: the added row's wash.
  expect(dialog.innerHTML).toContain("bg-emerald-500/8");

  // Read-only: no composer, and nothing that could reach the child's agent.
  expect(dialog.querySelector("textarea")).toBeNull();
  expect(dialog.querySelector("[aria-label='Send']")).toBeNull();
  expect(dialog.querySelector("[aria-label='Stop']")).toBeNull();
});

test("a running child can be opened, and its rows land under the reader", async () => {
  const host = paint(store);
  const release = harness.holdTurn();
  try {
    await delegate(host);
    await open(host);

    const dialog = modal(host);
    // Opened mid-run, so the header says so rather than reading as finished.
    expect(dialog.querySelector("header")!.textContent).toContain("Running");
    expect(dialog.textContent).toContain(SUBAGENT_PROMPT);
    expect(dialog.textContent).not.toContain(SUBAGENT_ANSWER);

    release();
    // Live: the child's later entries arrive in the open modal, driven by the
    // parent's own progress frames for that call.
    await until(
      () => childTexts().includes(SUBAGENT_ANSWER),
      "the child's answer"
    );
    flush();
    expect(dialog.textContent).toContain(CHILD_PATCH_LINE);
    await until(settled, "the delegated call to settle");
    flush();
    expect(dialog.querySelector("header")!.textContent).not.toContain(
      "Running"
    );
  } finally {
    release();
  }
});

test("closing lets the child go, and reopening reads the same run", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");
  await open(host);
  const before = childTexts();

  const sent = spyOn(store.client, "send");
  modal(host).querySelector<HTMLButtonElement>("[aria-label='Close']")!.click();
  flush();
  expect(modal(host).open).toBe(false);
  expect(store.state.subagent).toBeUndefined();
  // The watch goes with the modal, and is *told* to go: a server left holding
  // one keeps a projection of the child growing behind a closed sheet.
  expect(sent.mock.calls.map(([command]) => command.type)).toContain(
    "unwatch_subagent"
  );
  sent.mockRestore();

  await open(host);

  expect(modal(host).open).toBe(true);
  expect(childTexts()).toEqual(before);
  expect(modal(host).textContent).toContain(SUBAGENT_ANSWER);
});

/**
 * A watch reads a child of the session this connection is attached to, so the
 * server drops it the moment that changes. The modal goes with it rather than
 * hanging over another conversation holding the last one's child.
 */
test("leaving the session closes the modal over its child", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");
  await open(host);

  await store.newSession();
  await until(
    () => store.state.subagent === undefined,
    "the watch to be let go"
  );
  flush();

  expect(modal(host).open).toBe(false);
});

/**
 * The phone gesture for "out of this". Without the pushed entry, Back leaves
 * the session behind the modal, which on the one device with no other way out
 * is the difference between a modal and a trap.
 */
test("Back closes the modal rather than leaving the session", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");

  await open(host);
  // An entry of the modal's own is on top of the stack, which is what Back
  // pops instead of the page the session is on.
  expect(history.state).toEqual({ pimModal: true });

  globalThis.dispatchEvent(new Event("popstate"));
  flush();

  expect(modal(host).open).toBe(false);
  expect(store.state.subagent).toBeUndefined();
});

/**
 * A reload is a new store over the same session and the same server: the
 * child's work is a file, so what the modal answers with survives the tab
 * that opened it.
 */
test("a page reloaded mid-run reopens onto the same child", async () => {
  const first = paint(store);
  const release = harness.holdTurn();
  try {
    await delegate(first);

    store.dispose();
    store = await connect(store.state.sessionId);
    const host = paint(store);
    await until(() => opener(host) !== null, "the subagent row after a reload");

    await open(host);
    expect(modal(host).textContent).toContain(SUBAGENT_PROMPT);

    release();
    await until(
      () => childTexts().includes(SUBAGENT_ANSWER),
      "the child's answer"
    );
    flush();
    expect(modal(host).textContent).toContain(SUBAGENT_ANSWER);
  } finally {
    release();
  }
});

/**
 * A watch dies with the socket and cannot be resumed, so a modal that is
 * still open when the socket comes back asks again from the child's first
 * entry — and the ordinals it already painted are what keep that from being
 * the run twice over.
 */
test("a modal open across a reconnect re-watches without doubling", async () => {
  const host = paint(store);
  const release = harness.holdTurn();
  try {
    await delegate(host);
    await open(host);
    const before = childTexts();

    await harness.dropGateway();
    await until(() => store.state.connection !== "open", "the socket to drop");
    harness.startGateway();
    await until(
      () => store.state.connection === "open",
      "the socket to return"
    );

    expect(store.state.subagent?.callId).toBe(SUBAGENT_CALL_ID);
    // The re-watch replays the child from its first entry, and the ordinals
    // already painted are what keep the reader from seeing the run twice.
    expect(childTexts()).toEqual(before);

    // Proof the watch is live again rather than merely un-cleared: the child
    // is still running, and what it writes from here lands in the open modal.
    release();
    await until(
      () => childTexts().includes(SUBAGENT_ANSWER),
      "the child's answer after the reconnect"
    );
    flush();
    expect(modal(host).textContent).toContain(SUBAGENT_ANSWER);
    expect(
      childTexts().filter((text) => text === SUBAGENT_PROMPT)
    ).toHaveLength(1);
  } finally {
    release();
  }
});

/**
 * The same anchoring the conversation uses, because it is the same anchor: a
 * child that writes while its modal is open follows the end for a reader who
 * is at it, and leaves alone one who has scrolled up to read a tool result.
 */
test("the child's rows follow the end, and never yank a reader off it", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");
  await open(host);
  const scroller = scrollerOf(modal(host));

  grow(90, "still working on it");
  expect(scroller.scrollTop).toBe(1000);

  scroller.scrollTop = 120;
  scroller.dispatchEvent(new Event("scroll"));
  grow(91, "and one more thing");

  expect(scroller.scrollTop).toBe(120);
});
