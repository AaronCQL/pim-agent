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

function paintTool(view: ToolView, isPartial = false): HTMLElement {
  const host = mountPoint();
  render(() => <ToolCard view={view} isPartial={isPartial} />, host);
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

  test("a section paints its icon and recurses into its content", () => {
    const html = paint([SAMPLES.section]);
    expect(html).toContain("i-lucide-pencil");
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
    expect(html).toContain("text-red-400");
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

  test("each frame paints its own wrapper class", () => {
    const host = mountPoint();
    render(() => <Body blocks={[SAMPLES.text, SAMPLES.code]} />, host);
    flush();
    expect(host.innerHTML).toContain("overflow-x-auto");
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

  test("a partial call drops the body and the affordance with it", () => {
    const host = paintTool(view, true);
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).toContain("+2");
  });

  test("labelTone tints the label and icon maps to a glyph class", () => {
    const html = paintTool(view).innerHTML;
    expect(html).toContain("text-sky-400");
    expect(html).toContain("i-lucide-pencil");
  });

  test("a view with no body renders a head with no disclosure", () => {
    const host = paintTool({ title: [SAMPLES.text] });
    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector(".i-lucide-wrench")).not.toBeNull();
  });
});
