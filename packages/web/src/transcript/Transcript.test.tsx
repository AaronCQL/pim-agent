import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { clockTime } from "../format";
import { FIXTURE_EVENTS } from "../replay/fixture";
import { mountPoint } from "../test/dom";
import { DIFF_ROW_CLASSES } from "../view/tokens";
import { Transcript } from "./Transcript";
import { toRows } from "./rows";

const events = (await Bun.file(
  FIXTURE_EVENTS
).json()) as readonly DurableEvent[];

function replay(source: readonly DurableEvent[] = events): HTMLElement {
  const host = mountPoint();
  render(() => <Transcript events={source} />, host);
  flush();
  return host;
}

describe("rows", () => {
  test("a result replaces its call in place instead of appending a row", () => {
    const rows = toRows(events);
    const tools = rows.filter((row) => row.kind === "tool");

    expect(tools.map((row) => row.id)).toHaveLength(
      new Set(tools.map((r) => r.id)).size
    );
    expect(tools.every((row) => row.isPartial === false)).toBe(true);
  });

  test("a call whose result never landed stays a partial row", () => {
    const call = events.find(
      (event) => event.type === "message" && event.toolCalls !== undefined
    );
    const rows = toRows([call as DurableEvent]);

    expect(rows.filter((row) => row.kind === "tool")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "tool")?.isPartial).toBe(true);
  });

  test("an empty assistant message that only carried a call gets no bubble", () => {
    const rows = toRows([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "assistant",
        text: "",
        timestamp: 0,
        toolCalls: [{ callId: "c", name: "read", view: { title: [] } }],
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool"]);
  });

  test("reasoning is trimmed, and whitespace alone is no reasoning at all", () => {
    const message = (thinking: string): DurableEvent => ({
      seq: 1,
      type: "message",
      messageId: "m",
      role: "assistant",
      text: "Done.",
      timestamp: 0,
      thinking,
    });

    const [row] = toRows([message("\nLet me look.\n\n")]);
    expect(row).toMatchObject({ kind: "message", thinking: "Let me look." });

    const [blank] = toRows([message("\n\n")]);
    expect(blank).toMatchObject({ kind: "message", text: "Done." });
    expect(blank).not.toHaveProperty("thinking");
  });
});

describe("row grouping", () => {
  test("a run of tool calls is one group, so the calls stack with no gap", () => {
    const call = (callId: string): DurableEvent => ({
      seq: 1,
      type: "tool_result",
      callId,
      name: "read",
      view: { title: [{ kind: "text", text: callId }] },
      isError: false,
    });
    const host = replay([call("a"), call("b"), call("c")]);

    // One wrapper, three rows: only the wrappers are spaced by a blank line.
    const groups = [...host.querySelectorAll(":scope > div > div")];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll("article")).toHaveLength(3);
  });
});

describe("static replay of a real session", () => {
  test("renders every durable event without a live connection", () => {
    const host = replay();

    expect(host.textContent).toContain("Modernise the string building");
    expect(host.querySelectorAll("article").length).toBeGreaterThan(4);
  });

  test("a body sits behind a disclosure, and nothing opens itself", () => {
    const details = [...replay().querySelectorAll("details")];
    const diff = details.find((node) =>
      node.innerHTML.includes(DIFF_ROW_CLASSES.added)
    );
    const read = details.find((node) =>
      node.textContent?.includes("export function greet")
    );

    expect(diff?.textContent).toContain("  return `Hello, ${name}!`;");
    expect(diff?.open).toBe(false);
    expect(read?.open).toBe(false);
  });

  test("the failed bash call is painted with a rose rule, not a card", () => {
    const host = replay();
    const errored = [...host.querySelectorAll("article")].filter((node) =>
      node.innerHTML.includes("bg-rose-400")
    );

    expect(errored).toHaveLength(1);
    expect(errored[0]?.textContent).toContain("tsc --noEmit greeter.ts");
    // No fill and no border box: the rule and the caret carry the failure.
    expect(errored[0]?.className).not.toContain("bg-");
  });

  test("a user turn is a card and an assistant turn is bare prose", () => {
    const [first] = [...replay().querySelectorAll("article")];

    expect(first?.textContent).toContain("Modernise the string building");
    expect(first?.querySelector("div")?.className).toContain("bg-neutral-850");
    // The wall clock beneath the card, in the reader's own timezone.
    const stamp = events.find((event) => event.type === "message")?.timestamp;
    expect(first?.textContent).toContain(clockTime(stamp ?? 0));
  });

  test("the final assistant turn renders markdown, not source", () => {
    const host = replay();

    expect(host.querySelector(".pim-markdown h2")?.textContent).toBe("Done");
    expect(host.querySelectorAll(".pim-markdown table th").length).toBe(2);
    expect(host.querySelector(".pim-markdown pre code")?.textContent) //
      .toContain("export function greet");
    expect(host.textContent).not.toContain("## Done");
  });
});
