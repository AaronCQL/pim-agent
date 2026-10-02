import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import {
  CHILD_PATCH_LINE,
  GatewayHarness,
  SUBAGENT_ANSWER,
  SUBAGENT_CALL_ID,
  SUBAGENT_PROMPT,
} from "../test/gateway";
import { until } from "#core/shared/fixtures/wait";

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
    retryMs: 0,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return opened.connect().then(() => opened);
}

function paint(target: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={target} settings={new Settings()} />, host);
  flush();
  return host;
}

function modal(host: HTMLElement): HTMLDialogElement {
  return host.querySelector<HTMLDialogElement>(
    "dialog[aria-label='Subagent']"
  )!;
}

function opener(host: HTMLElement): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Subagent")
    ) ?? null
  );
}

function childTexts(): readonly string[] {
  return (store.state.subagent?.durable ?? []).flatMap((event) =>
    event.type === "message" ? [event.text] : []
  );
}

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

function settled(): boolean {
  return (
    !store.isBusy() &&
    store.state.durable.some(
      (event) =>
        event.type === "tool_result" && event.callId === SUBAGENT_CALL_ID
    )
  );
}

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
  expect(dialog.textContent).toContain(SUBAGENT_PROMPT);
  expect(dialog.textContent).toContain(SUBAGENT_ANSWER);

  const disclosure = dialog.querySelector("details")!;
  expect(disclosure.textContent).toContain("src/config.ts");
  expect(disclosure.open).toBe(false);
  disclosure.querySelector("summary")!.click();
  flush();
  expect(disclosure.open).toBe(true);
  expect(dialog.textContent).toContain(CHILD_PATCH_LINE);
  // Painted as a diff.
  expect(dialog.innerHTML).toContain("bg-emerald-500/8");

  // Read-only.
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
    expect(dialog.querySelector("header")!.textContent).toContain("Running");
    expect(dialog.textContent).toContain(SUBAGENT_PROMPT);
    expect(dialog.textContent).not.toContain(SUBAGENT_ANSWER);

    release();
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
  expect(sent.mock.calls.map(([command]) => command.type)).toContain(
    "unwatch_subagent"
  );
  sent.mockRestore();

  await open(host);

  expect(modal(host).open).toBe(true);
  expect(childTexts()).toEqual(before);
  expect(modal(host).textContent).toContain(SUBAGENT_ANSWER);
});

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

test("Back closes the modal rather than leaving the session", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");

  await open(host);
  expect(history.state).toEqual({ pimModal: true });

  globalThis.dispatchEvent(new Event("popstate"));
  flush();

  expect(modal(host).open).toBe(false);
  expect(store.state.subagent).toBeUndefined();
});

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
    expect(childTexts()).toEqual(before);

    // The watch is live again, not just un-cleared.
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

test("the child's scroller unpins when scrolled up", async () => {
  const host = paint(store);
  await delegate(host);
  await until(settled, "the delegated call to settle");
  await open(host);
  const scroller = modal(host).querySelector<HTMLElement>(
    "div.overflow-y-auto"
  )!;
  expect(scroller.classList.contains("[overflow-anchor:none]")).toBe(true);

  grow(90, "still working on it");
  expect(scroller.textContent).toContain("still working on it");

  scroller.scrollTop = -120;
  scroller.dispatchEvent(new Event("scroll"));
  grow(91, "and one more thing");

  expect(scroller.textContent).toContain("and one more thing");
  expect(scroller.scrollTop).toBe(-120);
  expect(scroller.classList.contains("[overflow-anchor:none]")).toBe(false);
});
