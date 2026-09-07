import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import {
  GatewayHarness,
  SUBAGENT_CALL_ID,
  SUBAGENT_FAIL_CALL_ID,
  SUBAGENT_FAILURE,
  SUBAGENT_PROMPT,
  until,
} from "../test/gateway";

/**
 * The card face, against the real gateway: what a reader who never opens the
 * modal is told. Every view here is the one the server projected — a settled
 * call's, a partial call's, and pi's own error view for a call that threw —
 * because the three states are exactly what those three views differ in.
 */

let harness: GatewayHarness;
let store: SessionStore;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  store = new SessionStore({
    url: harness.url,
    cwd: harness.tmp,
    pickerDebounceMs: 0,
    backoffMs: () => 0,
  });
  await store.connect();
});

afterEach(async () => {
  store.dispose();
  await harness.stop();
});

function paint(): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={store} />, host);
  flush();
  return host;
}

function card(host: HTMLElement): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Subagent")
    ) ?? null
  );
}

function modal(host: HTMLElement): HTMLDialogElement {
  return host.querySelector<HTMLDialogElement>(
    "dialog[aria-label='Subagent']"
  )!;
}

/** Delegates, and waits for the run to have a card. */
async function delegate(host: HTMLElement, text: string): Promise<void> {
  await store.prompt(text);
  await until(() => card(host) !== null, "the subagent card");
  flush();
}

/** The child's own log has reached the store, which is what the modal paints. */
function childSaid(text: string): () => boolean {
  return () =>
    (store.state.subagent?.events ?? []).some(
      (event) => event.type === "message" && event.text === text
    );
}

/** The turn finished: the call is written down and the agent is idle. */
function settled(callId: string): () => boolean {
  return () =>
    !store.isBusy() &&
    store.state.durable.some(
      (event) => event.type === "tool_result" && event.callId === callId
    );
}

test("a settled run reads its prompt and what it spent", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  const face = card(host)!;
  expect(face.textContent).toContain(SUBAGENT_PROMPT);
  // The roster and the accounting, muted under the prompt — the summary the
  // tool renders in every state.
  expect(face.textContent).toContain("2 turns");
  expect(face.textContent).not.toContain("Running");
  expect(face.innerHTML).not.toContain("animate-spin");
  expect(face.innerHTML).not.toContain("text-rose-400");
});

/**
 * No caret, no spine, no disclosure: the payload of this row is a session,
 * and it is read in the modal rather than hung under the row.
 */
test("the card is a button rather than a disclosure", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  const face = card(host)!;
  expect(face.tagName).toBe("BUTTON");
  expect(face.querySelector("details")).toBeNull();
  expect(face.querySelector("summary")).toBeNull();
  expect(face.innerHTML).not.toContain("chevron");
  // Filled and rounded, on a padding of whole `--line` rows and no border, so
  // the tool rows either side of it keep the grid.
  expect(face.className).toContain("rounded-lg");
  expect(face.className).toContain("bg-neutral-900");
  expect(face.className).toContain("py-[--line]");
  expect(face.className).not.toContain("border");
});

test("a running run spins in amber before anything has settled", async () => {
  const host = paint();
  const release = harness.holdTurn();
  try {
    await delegate(host, "delegate this");

    const face = card(host)!;
    expect(face.textContent).toContain("Running");
    expect(face.textContent).toContain(SUBAGENT_PROMPT);
    expect(face.innerHTML).toContain("text-amber-400");
    expect(face.innerHTML).toContain("animate-spin");
  } finally {
    release();
  }
});

/**
 * A thrown run persists no details, so the card says what happened and stops:
 * any turn count or cost still hanging off the view was measured mid-flight
 * and was never what the run did.
 */
test("a failed run reads the failure, and no roster or cost", async () => {
  const host = paint();
  await delegate(host, "delegate this badly");
  await until(settled(SUBAGENT_FAIL_CALL_ID), "the failed call to settle");
  flush();

  const face = card(host)!;
  expect(face.textContent).toContain(`Subagent failed · ${SUBAGENT_FAILURE}`);
  expect(face.textContent).toContain(SUBAGENT_PROMPT);
  expect(face.textContent).not.toContain("Running");
  // The tool's own renderer still offers a roster and a turn count for a call
  // it never saw finish. The card drops both rather than reporting them.
  expect(face.textContent).not.toContain("patch");
  expect(face.textContent).not.toContain("turns");
});

test("tapping the card opens the run in the modal", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  card(host)!.click();
  await until(childSaid(SUBAGENT_PROMPT), "the child's prompt");
  flush();

  expect(store.state.subagent?.callId).toBe(SUBAGENT_CALL_ID);
  expect(modal(host).open).toBe(true);
  expect(modal(host).textContent).toContain(SUBAGENT_PROMPT);
});

/**
 * The path to a child log is derived from the call id rather than looked up
 * in the parent's, which is what keeps the runs most worth reading openable:
 * the failed one has nothing left in the parent log to look up.
 */
test("a failed run opens too, and its child log is what answers", async () => {
  const host = paint();
  await delegate(host, "delegate this badly");
  await until(settled(SUBAGENT_FAIL_CALL_ID), "the failed call to settle");
  flush();

  card(host)!.click();
  await until(childSaid(SUBAGENT_PROMPT), "the failed child's prompt");
  flush();

  expect(store.state.subagent?.callId).toBe(SUBAGENT_FAIL_CALL_ID);
  expect(modal(host).open).toBe(true);
  expect(modal(host).textContent).toContain(SUBAGENT_PROMPT);
});
