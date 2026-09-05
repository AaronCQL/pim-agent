import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { FIXTURE_EVENTS } from "../replay/fixture";
import { mountPoint } from "../test/dom";
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
        toolCalls: [{ callId: "c", name: "read", view: { title: [] } }],
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool"]);
  });
});

describe("static replay of a real session", () => {
  test("renders every durable event without a live connection", () => {
    const host = replay();

    expect(host.textContent).toContain("Modernise the string building");
    expect(host.querySelectorAll("article").length).toBeGreaterThan(4);
  });

  test("a body sits behind a disclosure, and `collapsed: false` opens it", () => {
    const details = [...replay().querySelectorAll("details")];
    const diff = details.find((node) => node.textContent?.includes("@@ -"));
    const read = details.find((node) =>
      node.textContent?.includes("export function greet")
    );

    expect(diff?.textContent).toContain("+  return `Hello, ${name}!`;");
    // `edit` declares `collapsed: false`; nothing else in the session does.
    expect(diff?.open).toBe(true);
    expect(read?.open).toBe(false);
  });

  test("the failed bash call is painted as an error card", () => {
    const errored = [...replay().querySelectorAll("article")].filter((node) =>
      node.className.includes("border-red-900/60")
    );

    expect(errored).toHaveLength(1);
    expect(errored[0]?.textContent).toContain("tsc --noEmit greeter.ts");
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
