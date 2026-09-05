import "./test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent } from "#protocol/ServerEvent";
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

function paint(store: SessionStore): HTMLElement {
  const host = mountPoint();
  render(() => <Shell store={store} />, host);
  flush();
  return host;
}

function offline(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
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

    // The clank line is the only running indicator.
    expect(host.textContent).toContain("Clanking…");
  });

  test("the branch is a topbar chip and the context fill is half the pill", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0.5,
      status: "idle",
      contextPercent: 74.5,
      contextWindow: 1_000_000,
      branch: "feat/new-stuff",
      dirty: true,
    });
    flush();

    expect(host.innerHTML).toContain("i-griddy-icons:code-branch");
    expect(host.textContent).toContain("feat/new-stuff");

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
  });

  test("an error is a rose line above the composer", () => {
    const store = offline();
    const host = paint(store);

    store.ingest(attached());
    store.ingest({ type: "error", message: "provider said no" });
    flush();

    expect(host.textContent).toContain("provider said no");
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

function press(input: HTMLTextAreaElement, key: string): void {
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}
