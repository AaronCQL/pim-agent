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
          { kind: "context", text: "keep", oldLine: 1, newLine: 1 },
          { kind: "removed", text: "old", oldLine: 2 },
          { kind: "added", text: "new", newLine: 2 },
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

  // Spans are a cut-up line, not chips: only the text the producer wrote
  // separates them, so a stat reads `+2/-1` and not `+2 / -1`.
  test("adjacent spans carry no spacing of their own", () => {
    const host = mountPoint();
    render(() => <Blocks blocks={[SAMPLES.spans]} />, host);
    flush();
    expect(host.textContent).toBe("+2/-1");
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

  // The terminal's diff: a numbered gutter and a sign, no `@@` header, and no
  // disclosure of its own to open before the payload can be read.
  test("a diff paints one flat row per line, gutter included", () => {
    const host = mountPoint();
    render(() => <Blocks blocks={[SAMPLES.diff]} />, host);
    flush();

    expect(host.querySelector("details")).toBeNull();
    expect(host.innerHTML).not.toContain("@@");
    expect(host.innerHTML).toContain("bg-emerald-500/10");
    expect(host.innerHTML).toContain("bg-rose-500/10");
    expect(host.textContent).toContain(" 2 − old");
    expect(host.textContent).toContain(" 2 + new");
    // The washes have to reach past the frame's edge, not stop at it.
    expect(host.querySelector("div")?.className).toContain("w-max");
  });

  // Only the code, never the gutter: a diff is copied to be pasted somewhere.
  test("the gutter is unselectable, so a copied diff is code alone", () => {
    expect(paint([SAMPLES.diff])).toContain("select-none");
  });

  /**
   * The two cuts of a changed line — what the syntax highlighter makes of it
   * and which of its characters actually changed — landing on the same row:
   * the keyword keeps its colour and only the new word takes the brighter
   * wash. `+` and `−` carry the change; the wash says where inside the line.
   */
  test("a diff colours its code and washes only the words that changed", async () => {
    const host = mountPoint();
    render(
      () => (
        <Blocks
          blocks={[
            {
              kind: "diff",
              path: "greeter.ts",
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: [
                    {
                      kind: "added",
                      text: "const name = 2;",
                      newLine: 1,
                      emphasis: [{ start: 13, end: 14 }],
                    },
                  ],
                },
              ],
            },
          ]}
        />
      ),
      host
    );

    for (let attempt = 0; attempt < 50; attempt += 1) {
      flush();
      if (host.innerHTML.includes("text-fuchsia-300")) {
        break;
      }
      await Bun.sleep(10);
    }

    const keyword = [...host.querySelectorAll("span")].find(
      (node) => node.textContent === "const"
    );
    const changed = [...host.querySelectorAll("span")].filter((node) =>
      node.className.includes("bg-emerald-500/25")
    );

    expect(keyword?.className).toContain("text-fuchsia-300");
    expect(changed.map((node) => node.textContent)).toEqual(["2"]);
    expect(host.textContent).toContain("const name = 2;");
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
    expect(details?.textContent).toContain(" 2 + new");
    expect(host.textContent).toContain("+2");
    expect(host.querySelector("details > div")?.textContent).not.toContain(
      "+2"
    );
  });

  test("every row starts closed, `collapsed: false` included", () => {
    expect(paintTool(view).querySelector("details")?.open).toBe(false);
    expect(
      paintTool({ ...view, collapsed: false }).querySelector("details")?.open
    ).toBe(false);
  });

  // A row is at full strength when *it* is open, never because something
  // inside it is; the child combinator is what says so, and a diff body — the
  // one payload that used to nest disclosures — now holds none at all.
  test("a closed row recedes, and its body opens nothing of its own", () => {
    const host = paintTool(view);
    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.querySelector("article")?.className).toContain(
      "has-[>details[open]]:opacity-100"
    );
  });

  test("a partial call keeps the body, so output can be watched", () => {
    const host = paintTool(view, true);
    expect(host.querySelector("details")).not.toBeNull();
    expect(host.textContent).toContain("+2");
  });

  test("a body of blank blocks is no body: an unstarted call has no disclosure", () => {
    const host = paintTool(
      { title: [SAMPLES.file], body: [{ kind: "text", text: "" }] },
      true
    );
    expect(host.querySelector("details")).toBeNull();
    // It keeps the caret, in amber, so the row keeps its shape while it waits.
    expect(host.innerHTML).toContain("bg-amber-400");
  });

  test("a row with nothing to open does not brighten on hover", () => {
    const pending = paintTool({ title: [SAMPLES.file] }, true);
    expect(pending.querySelector("article")?.className).not.toContain(
      "hover:opacity-100"
    );
    expect(paintTool(view).querySelector("article")?.className).toContain(
      "hover:opacity-100"
    );
  });

  test("labelTone tints the label, and no glyph is painted", () => {
    const html = paintTool(view).innerHTML;
    expect(html).toContain("text-indigo-300");
    // The caret is the only icon a row draws, and it carries state, not identity.
    expect(html.match(/i-griddy-icons:[\w-]+/g)).toEqual([
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

  // `Grep: /foo/ (2 files)`: the stat is an aside behind the subject, on the
  // subject's line, and the whole run wraps instead of being cut off.
  test("title details trail the subject in brackets, on one wrapping run", () => {
    const host = paintTool({
      label: "Grep",
      title: [
        { kind: "text", text: "/foo/" },
        { kind: "text", tone: "muted", text: "2 files" },
      ],
    });
    expect(host.textContent).toBe("Grep:/foo/ (2 files)");
    expect(host.innerHTML).not.toContain("truncate");
  });

  // `Edit: file.ts +2/-1`: the counters are punctuation and colour already.
  test("diff counters trail the path bare, with no brackets round them", () => {
    const host = paintTool({
      label: "Edit",
      title: [SAMPLES.file, SAMPLES.spans],
    });
    expect(host.textContent).not.toContain("(");
    expect(host.textContent).toContain("+2");
  });

  test("an error stays closed and previews ten lines of the failure", () => {
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

    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    flush();
    expect(host.innerHTML).toContain("bg-rose-400");
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
