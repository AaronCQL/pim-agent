import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { clockTime } from "../format";
import { FIXTURE_EVENTS } from "../replay/fixture";
import { HideThinking } from "../settings/Settings";
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

  test("a turn the model killed says so where it died", () => {
    const rows = toRows([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "assistant",
        text: "Let me check",
        timestamp: 0,
        error: "rate_limit_error: too many requests",
      },
    ]);

    expect(rows).toEqual([
      {
        kind: "message",
        id: "m",
        role: "assistant",
        text: "Let me check",
        timestamp: 0,
      },
      {
        kind: "notice",
        id: "m-error",
        severity: "error",
        text: "rate_limit_error: too many requests",
      },
    ]);
  });

  test("a failure with nothing streamed before it is still a row", () => {
    const rows = toRows([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "assistant",
        text: "",
        timestamp: 0,
        error: "overloaded_error",
      },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["notice"]);
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
  const call = (callId: string): DurableEvent => ({
    seq: 1,
    type: "tool_result",
    callId,
    name: "read",
    view: { title: [{ kind: "text", text: callId }] },
    isError: false,
  });

  test("a run of tool calls is one group, so the calls stack with no gap", () => {
    const host = replay([call("a"), call("b"), call("c")]);

    // One wrapper, three rows: only the wrappers are spaced by a blank line.
    const groups = [...host.querySelectorAll(":scope > div > div")];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll("article")).toHaveLength(3);
  });

  /**
   * A step that only thought before calling the next tool is a row with
   * nothing left in it once reasoning is hidden, and an empty row between two
   * calls is a blank line between two calls: it must not be there at all.
   */
  test("a step that only thought leaves no gap once thinking is hidden", () => {
    const host = mountPoint();
    const thought: DurableEvent = {
      seq: 2,
      type: "message",
      messageId: "m",
      role: "assistant",
      text: "",
      thinking: "Now the other file.",
      timestamp: 0,
    };
    render(
      () => (
        <HideThinking value={() => true}>
          <Transcript events={[call("a"), thought, call("b")]} />
        </HideThinking>
      ),
      host
    );
    flush();

    const groups = [...host.querySelectorAll(":scope > div > div")];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll("article")).toHaveLength(2);
  });
});

describe("painting", () => {
  const photo = (text: string): DurableEvent => ({
    seq: 1,
    type: "message",
    messageId: "m",
    role: "user",
    text,
    timestamp: 0,
    attachments: [
      {
        name: "shot.png",
        url: "http://gateway/attachment/s1/shot-1.png",
        isImage: true,
      },
    ],
  });

  test("a file on a message is the picture, not the path it was stored at", () => {
    const host = replay([photo("what is this?")]);
    const thumbnail = host.querySelector("img")!;

    expect(thumbnail.getAttribute("src")).toBe(
      "http://gateway/attachment/s1/shot-1.png"
    );
    expect(thumbnail.getAttribute("alt")).toBe("shot.png");
    expect(host.textContent).toContain("what is this?");
    expect(host.textContent).not.toContain("attachment/s1");
  });

  test("clicking the thumbnail opens it at the size of the window", () => {
    const host = replay([photo("what is this?")]);
    host
      .querySelector<HTMLButtonElement>("[aria-label='View shot.png']")!
      .click();
    flush();

    const shown = host.querySelector("dialog")!;
    expect(shown.open).toBe(true);
    expect(shown.querySelector("img")?.getAttribute("src")).toBe(
      "http://gateway/attachment/s1/shot-1.png"
    );
  });

  // Said with no words at all, which is most of how a screenshot is sent.
  test("a message that is only a picture draws no empty bubble", () => {
    const host = replay([photo("")]);

    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector(".bg-neutral-850")).toBeNull();
  });

  // Telegram keeps its uploads under a root this server does not publish, so
  // the bytes are a 404 and a broken glyph is not an answer.
  test("a picture the server cannot serve falls back to its name", () => {
    const host = replay([photo("look")]);
    host.querySelector("img")!.dispatchEvent(new Event("error"));
    flush();

    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")?.textContent).toBe("shot.png");
  });

  // A subagent's prompt is the message that showed this up: it names files,
  // and a path is one unbreakable run. The card is only ever as wide as its
  // text, so a break that waits for the box to have a width leaves the box
  // itself min-content wide — wider than the phone, hanging off its left
  // edge. There is no layout in the DOM stub to measure, so the rule that
  // makes the run count against the intrinsic width is the assertion.
  test("a user message breaks a run too long to fit instead of widening", () => {
    const host = replay([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "user",
        text: "read packages/web/src/transcript/SubagentModal.tsx",
        timestamp: 0,
      },
    ]);

    expect(
      host.querySelector(".bg-neutral-850 .pim-markdown")?.className
    ).toContain("wrap-anywhere");
  });

  // What was typed was written as markdown, so it is read back as markdown —
  // and a chat message's own newlines survive it, which is why the card no
  // longer carries `pre-wrap`.
  test("a sent user message is drawn as markdown, line breaks kept", () => {
    const host = replay([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "user",
        text: "look at `Card`:\n- it is **bold** now\n- and still two lines",
        timestamp: 0,
      },
    ]);
    const card = host.querySelector(".bg-neutral-850");

    expect(card?.querySelector("code")?.textContent).toBe("Card");
    expect(card?.querySelectorAll("li")).toHaveLength(2);
    expect(card?.querySelector("strong")?.textContent).toBe("bold");
  });

  test("a fenced block in a user message scrolls instead of widening the card", () => {
    const host = replay([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "user",
        text: "I like this:\n\n```\nAn opinionated distro of Pi, reachable from your terminal, browser, or Telegram.\n```",
        timestamp: 0,
      },
    ]);
    const card = host.querySelector(".bg-neutral-850");

    expect(card?.className).toContain("max-w-full");
    expect(card?.querySelector("pre")).not.toBeNull();
  });

  test("a dead turn is a tagged rose line where the answer would have been", () => {
    const host = replay([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "assistant",
        text: "",
        timestamp: 0,
        error: "rate_limit_error: too many requests",
      },
    ]);
    const notice = host.querySelector("p.text-rose-400");

    expect(notice?.querySelector("span")?.textContent).toBe("ERROR");
    expect(notice?.textContent).toContain(
      "rate_limit_error: too many requests"
    );
    expect(notice?.getAttribute("role")).toBe("alert");
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

    expect(first?.querySelector("div.bg-neutral-850")?.textContent).toContain(
      "Modernise the string building"
    );
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

  /**
   * The one row a reader can still act on: it has no time to show, because
   * it has not happened yet, and clicking it is how it is taken back.
   */
  test("a queued message is a button that says so, and it calls back", () => {
    const host = mountPoint();
    let edits = 0;
    render(
      () => (
        <Transcript
          events={[]}
          trailing={[
            {
              id: "o1",
              text: "wait, the other file",
              timestamp: 0,
              queued: true,
            },
          ]}
          onEdit={() => {
            edits += 1;
          }}
        />
      ),
      host
    );
    flush();

    const card = host.querySelector("button")!;
    expect(card.textContent).toContain("wait, the other file");
    expect(card.textContent).toContain("Queued. Click to edit.");

    card.click();
    expect(edits).toBe(1);
  });
});
