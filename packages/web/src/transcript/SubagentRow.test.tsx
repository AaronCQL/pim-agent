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
} from "../test/gateway";
import { until } from "#core/shared/fixtures/wait";

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
    retryMs: 0,
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

function spent(face: HTMLButtonElement): HTMLElement {
  return [...face.querySelectorAll("span")].find((span) =>
    /turns/u.test(span.textContent ?? "")
  )!;
}

async function delegate(host: HTMLElement, text: string): Promise<void> {
  await store.prompt(text);
  await until(() => row(host) !== null, "the subagent row");
  flush();
}

function childSaid(text: string): () => boolean {
  return () =>
    (store.state.subagent?.durable ?? []).some(
      (event) => event.type === "message" && event.text === text
    );
}

function settled(callId: string): () => boolean {
  return () =>
    !store.isBusy() &&
    store.state.durable.some(
      (event) => event.type === "tool_result" && event.callId === callId
    );
}

test("a settled run reads what it spent, and nothing else", async () => {
  const host = paint();
  await delegate(host, "delegate this");
  await until(settled(SUBAGENT_CALL_ID), "the delegated call to settle");
  flush();

  const face = row(host)!;
  expect(face.textContent).toBe("Subagent:2 turns ⬝ $0.02");
  expect(face.textContent).not.toContain(SUBAGENT_PROMPT);
  expect(face.innerHTML).not.toContain("animate-spin");
  expect(face.innerHTML).not.toContain("text-rose-400");
  expect(spent(face).className).not.toContain("text-");
  expect(face.innerHTML).toContain("text-indigo-300");
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
    expect(face.innerHTML).toContain("bg-amber-400");
    // The spent amount itself is not amber.
    expect(spent(face).className).not.toContain("text-");
  } finally {
    release();
  }
});

test("a failed run reads the failure, and no roster or cost", async () => {
  const host = paint();
  await delegate(host, "delegate this badly");
  await until(settled(SUBAGENT_FAIL_CALL_ID), "the failed call to settle");
  flush();

  const face = row(host)!;
  expect(face.textContent).toContain(`Subagent:failed · ${SUBAGENT_FAILURE}`);
  expect(face.innerHTML).toContain("bg-rose-400");
  // The stale mid-run turn count and cost are dropped.
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

// The child log path is derived from the call id, so failed runs still open.
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
