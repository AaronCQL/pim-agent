import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { mountPoint } from "../test/dom";
import { Blocks, Body } from "./Blocks";
import { ToolCard } from "./ToolCard";
import { FRAMES, groupByFrame } from "./tokens";

function paint(blocks: readonly ViewBlock[]): string {
  const host = mountPoint();
  render(() => <Blocks blocks={blocks} />, host);
  flush();
  return host.innerHTML;
}

function paintTool(
  view: ToolView,
  isPartial = false,
  name?: string
): HTMLElement {
  const host = mountPoint();
  render(
    () => <ToolCard view={view} isPartial={isPartial} name={name} />,
    host
  );
  flush();
  return host;
}

/** One representative block of every kind, so the union stays fully covered. */
const SAMPLES = {
  text: { kind: "text", text: "plain line", tone: "muted" },
  markdown: { kind: "markdown", text: "**bold** text\n" },
  spans: {
    kind: "spans",
    spans: [
      { text: "+2", tone: "added" },
      { text: "/" },
      { text: "-1", tone: "removed", strike: true },
    ],
  },
  section: {
    kind: "section",
    label: "greeter.ts",
    icon: "edit",
    content: [{ kind: "text", text: "inner" }],
  },
  code: {
    kind: "code",
    lang: "ts",
    text: "const a = 1;\nconst b = 2;",
    startLine: 7,
  },
  diff: {
    kind: "diff",
    path: "greeter.ts",
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "context", text: "keep" },
          { kind: "removed", text: "old" },
          { kind: "added", text: "new" },
        ],
      },
    ],
  },
  file: {
    kind: "file",
    path: "src/greeter.ts",
    range: [1, 7],
    truncated: true,
  },
  list: {
    kind: "list",
    ordered: true,
    items: [
      { kind: "text", text: "first" },
      { kind: "list", items: [{ kind: "text", text: "nested" }] },
    ],
  },
  kv: { kind: "kv", pairs: [["exit", "127"]] },
  link: { kind: "link", href: "https://example.com", label: "docs" },
  notice: { kind: "notice", severity: "error", text: "boom" },
} as const satisfies {
  [K in ViewBlock["kind"]]: Extract<ViewBlock, { kind: K }>;
};

describe("ViewBlock HTML painter", () => {
  test("every kind in the union has a painter and emits an element", () => {
    for (const [kind, block] of Object.entries(SAMPLES)) {
      const html = paint([block]);
      expect(`${kind}: ${html === "" ? "empty" : "painted"}`).toBe(
        `${kind}: painted`
      );
    }
  });

  test("tones, strike and inline code become classes, not markup", () => {
    const html = paint([SAMPLES.spans]);
    expect(html).toContain("text-emerald-400");
    expect(html).toContain("line-through");
  });

  test("a list recurses into nested blocks", () => {
    const html = paint([SAMPLES.list]);
    expect(html).toContain("<ol");
    expect(html).toContain("nested");
  });

  test("a section paints its label and recurses into its content", () => {
    const html = paint([SAMPLES.section]);
    // No glyph anywhere on the web: `icon` is declared and deliberately unpainted.
    expect(html).not.toContain("i-griddy");
    expect(html).toContain("greeter.ts");
    expect(html).toContain("inner");
  });

  test("a diff paints one row per line, marker included", () => {
    const html = paint([SAMPLES.diff]);
    expect(html).toContain("@@ -1,2 +1,2 @@");
    expect(html).toContain("-old");
    expect(html).toContain("+new");
    expect(html).toContain("bg-emerald-500/10");
  });

  test("a code block numbers from startLine", () => {
    const html = paint([SAMPLES.code]);
    expect(html).toContain(">7<");
    expect(html).toContain(">8<");
  });

  test("a file range renders as path:start-end", () => {
    expect(paint([SAMPLES.file])).toContain(":1-7");
    expect(paint([{ kind: "file", path: "a.ts", range: [40, undefined] }])) //
      .toContain(":40");
  });

  test("markdown blocks go through the streaming renderer", () => {
    expect(paint([SAMPLES.markdown])).toContain("<strong>bold</strong>");
  });

  test("a notice carries its severity as a role and a tone", () => {
    const html = paint([SAMPLES.notice]);
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-rose-400");
  });
});

describe("body frames", () => {
  test("consecutive same-frame blocks share one container", () => {
    const groups = groupByFrame([SAMPLES.text, SAMPLES.spans, SAMPLES.code]);
    expect(groups.map((group) => group.frame)).toEqual(["flow", "embed"]);
    expect(groups[0]?.blocks).toHaveLength(2);
  });

  test("headings never merge, so two sub-items keep two rules", () => {
    const groups = groupByFrame([SAMPLES.section, SAMPLES.section]);
    expect(groups.map((group) => group.frame)).toEqual(["heading", "heading"]);
  });

  test("each frame paints its own wrapper class, and an embed is not a card", () => {
    const host = mountPoint();
    render(() => <Body blocks={[SAMPLES.text, SAMPLES.code]} />, host);
    flush();
    expect(host.innerHTML).toContain("overflow-x-auto");
    expect(host.innerHTML).not.toContain("rounded bg-neutral-900/60");
  });

  test("markdown and payloads are embeds, prose is flow", () => {
    expect(FRAMES.markdown).toBe("embed");
    expect(FRAMES.diff).toBe("embed");
    expect(FRAMES.text).toBe("flow");
    expect(FRAMES.section).toBe("heading");
  });
});

describe("ToolCard", () => {
  const view: ToolView = {
    label: "Edit",
    labelTone: "accent",
    icon: "edit",
    title: [SAMPLES.file],
    summary: [SAMPLES.spans],
    body: [SAMPLES.diff],
  };

  test("summary renders outside the disclosure, body inside it", () => {
    const host = paintTool(view);
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain("@@ -1,2 +1,2 @@");
    expect(host.textContent).toContain("+2");
    expect(host.querySelector("details > div")?.textContent).not.toContain(
      "+2"
    );
  });

  test("collapsed: false forces the body open", () => {
    expect(paintTool(view).querySelector("details")?.open).toBe(false);
    expect(
      paintTool({ ...view, collapsed: false }).querySelector("details")?.open
    ).toBe(true);
  });

  test("a partial call keeps the body, so output can be watched", () => {
    const host = paintTool(view, true);
    expect(host.querySelector("details")).not.toBeNull();
    expect(host.textContent).toContain("+2");
  });

  test("a body of blank blocks is no body: an unstarted call has no caret", () => {
    const host = paintTool(
      { title: [SAMPLES.file], body: [{ kind: "text", text: "" }] },
      true
    );
    expect(host.querySelector("details")).toBeNull();
  });

  test("labelTone tints the label, and no glyph is painted", () => {
    const html = paintTool(view).innerHTML;
    expect(html).toContain("text-indigo-300");
    // The caret is the only icon a row draws, and it carries state, not identity.
    expect(html.match(/i-griddy-icons:[\w-]+/g)).toEqual([
      "i-griddy-icons:chevron-right-small-filled",
      "i-griddy-icons:copy",
      "i-griddy-icons:chevron-right-small-filled",
    ]);
  });

  test("the label falls back to the tool name the wire carried", () => {
    const host = paintTool({ title: [SAMPLES.text] }, false, "bash");
    expect(host.textContent).toStartWith("bash:");
  });

  test("a view with no body renders a head with no disclosure", () => {
    const host = paintTool({ title: [SAMPLES.text] });
    expect(host.querySelector("details")).toBeNull();
  });

  test("an error opens by default and previews ten lines of the failure", () => {
    const host = mountPoint();
    const text = Array.from({ length: 14 }, (_, line) => `line ${line}`);
    render(
      () => (
        <ToolCard
          view={{ title: [], body: [{ kind: "text", text: text.join("\n") }] }}
          isError
        />
      ),
      host
    );
    flush();

    expect(host.querySelector("details")?.open).toBe(true);
    expect(host.innerHTML).toContain("border-rose-400");
    expect(host.textContent).toContain("line 9");
    expect(host.textContent).not.toContain("line 10");
    expect(host.textContent).toContain("… 4 more lines");

    host
      .querySelector("details button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    expect(host.textContent).toContain("line 13");
  });
});
