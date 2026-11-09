import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ToolView } from "#core/view/ViewBlock";
import type { DurableEvent } from "#protocol/ServerEvent";
import { clockTime } from "../format";
import { FIXTURE_EVENTS } from "../replay/fixture";
import { HideThinking } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import {
  result,
  spawnView,
  statusView,
  steerView,
  stopView,
  syncRunView,
} from "../test/jobs";
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

    const groups = [...host.querySelectorAll(":scope > div > div")];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelectorAll("article")).toHaveLength(3);
  });

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

  test("a message that is only a picture draws no empty bubble", () => {
    const host = replay([photo("")]);

    expect(host.querySelectorAll("img")).toHaveLength(1);
    expect(host.querySelector(".bg-neutral-850")).toBeNull();
  });

  // e.g. Telegram uploads, which this server does not publish.
  test("a picture the server cannot serve falls back to its name", () => {
    const host = replay([photo("look")]);
    host.querySelector("img")!.dispatchEvent(new Event("error"));
    flush();

    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a")?.textContent).toBe("shot.png");
  });

  // Long paths otherwise widen the card past a phone screen.
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

  test("a skill is the command typed, then a closed row that opens onto its markdown", () => {
    const host = replay([
      {
        seq: 1,
        type: "message",
        messageId: "m",
        role: "user",
        text: "/skill:release cut it",
        timestamp: 0,
        skill: { name: "release", content: "# Release\n\nShip **it**." },
      },
    ]);
    const bubble = host.querySelector(".bg-neutral-850")!;
    const row = host.querySelector("details")!;

    expect(bubble.textContent).toBe("/skill:release cut it");
    expect(
      bubble.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(row.open).toBe(false);
    expect(row.querySelector("summary")?.textContent).toContain(
      "Skill:release"
    );
    expect(row.querySelector("strong")?.textContent).toBe("it");
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
    expect(errored[0]?.className).not.toContain("bg-");
  });

  test("a user turn is a card and an assistant turn is bare prose", () => {
    const [first] = [...replay().querySelectorAll("article")];

    expect(first?.querySelector("div.bg-neutral-850")?.textContent).toContain(
      "Modernise the string building"
    );
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

describe("background subagents", () => {
  function settle(
    seq: number,
    callId: string,
    view: ToolView,
    options: { readonly child?: string; readonly isError?: boolean } = {}
  ): DurableEvent {
    return {
      seq,
      type: "tool_result",
      callId,
      name: "subagent",
      view,
      isError: options.isError ?? false,
      ...(options.child === undefined
        ? {}
        : { child: { jobId: options.child, handle: "j1" } }),
    };
  }

  function paint(source: readonly DurableEvent[]): {
    readonly host: HTMLElement;
    readonly opened: readonly string[];
  } {
    const host = mountPoint();
    const opened: string[] = [];
    render(
      () => (
        <Transcript
          events={source}
          onOpenSubagent={(callId) => {
            opened.push(callId);
          }}
        />
      ),
      host
    );
    flush();
    return { host, opened };
  }

  function openers(host: HTMLElement): readonly HTMLButtonElement[] {
    return [
      ...host.querySelectorAll<HTMLButtonElement>(
        "button[aria-haspopup='dialog']"
      ),
    ];
  }

  test("a result is a subagent row that reads its state and opens its job's log", () => {
    const { host, opened } = paint([
      settle(1, "call_a", spawnView("call_a", "audit the parser"), {
        child: "call_a",
      }),
      result(2, "call_a", "done"),
      result(3, "call_b", "stopped"),
      result(4, "call_c", "interrupted", { line: "The process ended." }),
      result(5, "call_d", "failed", { line: "Subagent failed: boom" }),
    ] as readonly DurableEvent[]);

    expect(openers(host).map((button) => button.textContent)).toEqual([
      "Subagent:j1 ⬝ started",
      "Subagent:j1 ⬝ 2 turns ⬝ $0.04 ⬝ 2.0%/200K",
      "Subagent:j1 ⬝ stopped by user ⬝ 2 turns ⬝ $0.04 ⬝ 2.0%/200K",
      "Subagent:j1 ⬝ interrupted · The process ended.",
      "Subagent:j1 ⬝ failed · Subagent failed: boom",
    ]);

    for (const button of openers(host)) {
      button.click();
    }
    expect(opened).toEqual(["call_a", "call_a", "call_b", "call_c", "call_d"]);
  });

  test("only a row the server links to a log opens one; the rest are plain cards", () => {
    const { host, opened } = paint([
      settle(1, "call_s", statusView("j1")),
      settle(2, "call_t", stopView("j1")),
      settle(3, "call_u", steerView("j1")),
      settle(4, "call_f", syncRunView("audit the parser"), { isError: true }),
      settle(5, "call_old", syncRunView("audit the parser"), {
        child: "call_old",
      }),
    ]);

    expect(host.textContent).toContain("Subagent:j1 ⬝ status");
    expect(host.textContent).toContain("Subagent:j1 ⬝ stop ⬝ wrong file");
    expect(host.textContent).toContain("Subagent:j1 ⬝ steer");
    expect(openers(host)).toHaveLength(1);
    openers(host)[0]!.click();
    expect(opened).toEqual(["call_old"]);
  });
});
