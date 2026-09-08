import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
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
 * The row's face, against the real gateway: what a reader who never opens the
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
  render(() => <Shell store={store} settings={new Settings()} />, host);
  flush();
  return host;
}

function row(host: HTMLElement): HTMLButtonElement | null {
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

/** What the run spent, as its own element, so its colour can be read off it. */
function spent(face: HTMLButtonElement): HTMLElement {
  return [...face.querySelectorAll("span")].find((span) =>
    /turns/u.test(span.textContent ?? "")
  )!;
}

/** Delegates, and waits for the run to have a row. */
async function delegate(host: HTMLElement, text: string): Promise<void> {
  await store.prompt(text);
  await until(() => row(host) !== null, "the subagent row");
  flush();
}

/** The child's own log has reached the store, which is what the modal paints. */
function childSaid(text: string): () => boolean {
  return () =>
    (store.state.subagent?.durable ?? []).some(
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

/** The accounting takes the title's place, at the title's colour. */
test("a settled run reads what it spent, and nothing else", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  const face = row(host)!;
  expect(face.textContent).toBe("Subagent:2 turns ⬝ $0.02");
  // The prompt is the child's first message; it is read in the modal, not
  // repeated on a second line of a list whose every other entry is one.
  expect(face.textContent).not.toContain(SUBAGENT_PROMPT);
  expect(face.innerHTML).not.toContain("animate-spin");
  expect(face.innerHTML).not.toContain("text-rose-400");
  // The tool's own spans are muted; on the row they read at the transcript's
  // colour, like the path after `Read:`.
  expect(spent(face).className).not.toContain("text-");
  // Settled reads indigo, the transcript's accent, rather than title white.
  expect(face.innerHTML).toContain("text-indigo-300");
});

/**
 * A tool row in every respect but one: the payload is a session, so the row
 * is a button that goes to it rather than a disclosure that opens it in
 * place. The caret is the tell — it is there, so the row keeps the column
 * its neighbours are in, and it never turns, because nothing hangs below it.
 */
test("the row is a button rather than a disclosure", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  const face = row(host)!;
  expect(face.tagName).toBe("BUTTON");
  expect(face.getAttribute("aria-haspopup")).toBe("dialog");
  expect(face.querySelector("details")).toBeNull();
  expect(face.querySelector("summary")).toBeNull();
  // The same caret every tool row draws, in the same column, that never
  // turns and hangs no spine.
  expect(face.innerHTML).toContain("chevron-right-small-filled");
  expect(face.innerHTML).not.toContain("rotate-90");
  // No fill and no rounding: in this transcript those mean a user's turn,
  // and a run of tool calls is not one.
  expect(face.className).not.toContain("rounded");
  expect(face.className).not.toContain("bg-neutral-9");
  expect(face.className).not.toContain("border");
});

test("a running run spins, and reads what it has spent so far in amber", async () => {
  const host = paint();
  const release = harness.holdTurn();
  try {
    await delegate(host, "delegate this");

    const face = row(host)!;
    expect(face.textContent).toBe("Subagent:1 turns ⬝ $0.02");
    expect(face.innerHTML).toContain("text-amber-400");
    expect(face.innerHTML).toContain("animate-spin");
    // Amber reaches the caret too, exactly as it does on a tool call still
    // in flight.
    expect(face.innerHTML).toContain("bg-amber-400");
    // But not the accounting: what a run has spent so far is not a warning,
    // and the caret, the label and the spinner already say it is working.
    expect(spent(face).className).not.toContain("text-");
  } finally {
    release();
  }
});

/**
 * A thrown run persists no details, so the row says what happened and stops:
 * any turn count or cost still hanging off the view was measured mid-flight
 * and was never what the run did.
 */
test("a failed run reads the failure, and no roster or cost", async () => {
  const host = paint();
  await delegate(host, "delegate this badly");
  await until(settled(SUBAGENT_FAIL_CALL_ID), "the failed call to settle");
  flush();

  const face = row(host)!;
  expect(face.textContent).toContain(`Subagent:failed · ${SUBAGENT_FAILURE}`);
  // Rose reaches the caret, so a call that did not happen never reads like
  // one that did.
  expect(face.innerHTML).toContain("bg-rose-400");
  // The tool's own renderer still offers a turn count and a cost for a call
  // it never saw finish. The row drops both rather than reporting them.
  expect(face.textContent).not.toContain("turns");
  expect(face.textContent).not.toContain("$");
});

test("tapping the row opens the run in the modal", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  row(host)!.click();
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

  row(host)!.click();
  await until(childSaid(SUBAGENT_PROMPT), "the failed child's prompt");
  flush();

  expect(store.state.subagent?.callId).toBe(SUBAGENT_FAIL_CALL_ID);
  expect(modal(host).open).toBe(true);
  expect(modal(host).textContent).toContain(SUBAGENT_PROMPT);
});
