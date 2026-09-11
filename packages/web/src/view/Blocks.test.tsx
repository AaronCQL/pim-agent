import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { mountPoint } from "../test/dom";
import { Blocks, Body } from "./Blocks";
import { ToolCard, ToolCards } from "./ToolCard";
import {
  DIFF_EMPHASIS_CLASSES,
  DIFF_ROW_CLASSES,
  FRAMES,
  groupByFrame,
} from "./tokens";

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

/** The same row through the splitter the transcript actually mounts. */
function paintTools(name: string, view: ToolView): HTMLElement {
  const host = mountPoint();
  render(() => <ToolCards view={view} name={name} />, host);
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
  attachment: {
    kind: "attachment",
    name: "revenue.png",
    // Absolute, as it is by the time a painter sees one: the store resolves
    // every URL on the way in.
    url: "http://gateway/attachment/s1/revenue-1.png",
    isImage: true,
  },
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

  // A delivered file is the one block that is not a description of what the
  // agent did: it is the thing itself, drawn as the tile an inbound
  // attachment gets.
  test("an image attachment paints a picture and a way to keep it", () => {
    const host = mountPoint();
    render(() => <Blocks blocks={[SAMPLES.attachment]} />, host);
    flush();

    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe(SAMPLES.attachment.url);
    expect(image?.getAttribute("alt")).toBe("revenue.png");
    const download = host.querySelector("a[download]");
    expect(download?.getAttribute("href")).toBe(SAMPLES.attachment.url);
    expect(download?.getAttribute("download")).toBe("revenue.png");
  });

  test("a non-image attachment paints the chip that downloads it", () => {
    const host = mountPoint();
    render(
      () => (
        <Blocks
          blocks={[
            { ...SAMPLES.attachment, name: "report.pdf", isImage: false },
          ]}
        />
      ),
      host
    );
    flush();

    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("a[download]")?.getAttribute("download")).toBe(
      "report.pdf"
    );
    expect(host.textContent).toContain("report.pdf");
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
    expect(host.innerHTML).toContain(DIFF_ROW_CLASSES.added);
    expect(host.innerHTML).toContain(DIFF_ROW_CLASSES.removed);
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
      node.className.includes(DIFF_EMPHASIS_CLASSES.added)
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

  // The summary is the row's status, not its payload, so it rides in the
  // `<summary>` — visible in every state, and above the body when open, the
  // order `BodyRenderer` draws the two in.
  test("summary renders in the head, body behind the disclosure", () => {
    const host = paintTool(view);
    const details = host.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain(" 2 + new");
    expect(host.querySelector("details > summary")?.textContent).toContain(
      "+2"
    );
    expect(host.querySelector("details > div")?.textContent).not.toContain(
      "+2"
    );
  });

  test("every row starts closed, a diff row included", () => {
    expect(paintTool(view).querySelector("details")?.open).toBe(false);
  });

  test("a diff keeps full strength, since its colour is its meaning", () => {
    const body = paintTool(view).querySelector("details > div > div");
    expect(body?.className).toBe("");
  });

  test("other expanded output inherits its colour and is uniformly muted", () => {
    const host = paintTool({ ...view, body: [SAMPLES.code] });
    expect(host.querySelector("details > div > div")?.className).toBe(
      "opacity-60"
    );
  });

  // Markdown is prose a model wrote to be read — a subagent's answer — not
  // output a tool dumped, so it is not quoted material and does not recede.
  test("a markdown body keeps full strength", () => {
    const host = paintTool({ ...view, body: [SAMPLES.markdown, SAMPLES.kv] });
    expect(host.querySelector("details > div > div")?.className).toBe("");
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

  /**
   * Every other row recedes until it is asked for, because a transcript is a
   * list of what happened. A delivery is not what happened — it is the answer
   * — so the row holds full strength instead of waiting to be hovered.
   */
  test("a row that delivered a file does not recede", () => {
    const delivered: ToolView = {
      label: "Send File",
      title: [SAMPLES.file],
      summary: [SAMPLES.attachment],
    };
    const host = paintTool(delivered);
    expect(host.querySelector("article")?.className).not.toContain(
      "opacity-80"
    );
    expect(host.querySelector("img")).not.toBeNull();

    // And the rule is the block's, not the tool's: the same row without one.
    const plain = paintTool({ ...delivered, summary: [SAMPLES.spans] });
    expect(plain.querySelector("article")?.className).toContain("opacity-80");
  });

  /**
   * A delivery is the row's output, not a line in its head — so it hangs
   * below the disclosure rather than inside its `<summary>`, where a click
   * anywhere toggles the row. Reaching for the picture opens the picture.
   */
  test("a delivery hangs outside the disclosure it was made in", () => {
    const host = paintTool({
      label: "Send File",
      title: [SAMPLES.file],
      summary: [SAMPLES.attachment],
      body: [SAMPLES.code],
    });
    const details = host.querySelector("details")!;
    expect(details.querySelector("img")).toBeNull();

    host
      .querySelector("img")!
      .closest("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();

    expect(details.open).toBe(false);
    expect(host.querySelector("dialog")).not.toBeNull();
  });

  // The caret is not the only mark that carries state. A row that wraps or is
  // open hangs a rule the whole way down, so the rule reads what the caret
  // reads: amber in flight, rose once it has failed, and a quiet neutral —
  // not the caret's own — once there is no news in it.
  test("the spine carries the caret's state, in the caret's hues", () => {
    expect(paintTool(view, true).innerHTML).toContain("text-amber-400");
    expect(paintTool(view).innerHTML).toContain("text-neutral-750");
  });

  /**
   * And it hangs off the square as readily as off the caret. The rule means
   * "this ink continues the row above", which a four-line shell command that
   * opens onto nothing needs said as much as one that opens — a row that fits
   * its line is one `--line` tall, so the rule is zero-height and shows
   * nothing either way. What the mark changes is only whether it is a grip.
   */
  test("a row with nothing to open still hangs a rule", () => {
    const RULE = "[class*='top-[--line]']";
    const spine = (host: HTMLElement): string => {
      const rule = host.querySelector(RULE);
      expect(rule).not.toBeNull();
      return rule!.className;
    };

    for (const bodiless of [
      { title: [SAMPLES.file] },
      { title: [SAMPLES.file], summary: [SAMPLES.attachment] },
    ] satisfies readonly ToolView[]) {
      const rule = spine(paintTool(bodiless));
      expect(rule).toContain("w-2ch");
      expect(rule).not.toContain("cursor-pointer");
    }

    // In the state's hues, like the disclosure's own, and one rule only: a
    // row that opens gets its from the details it opens.
    expect(spine(paintTool({ title: [SAMPLES.file] }, true))).toContain(
      "text-amber-400"
    );
    expect(paintTool(view).querySelectorAll(RULE)).toHaveLength(1);
  });

  // So does the one word a reader scans for down the left edge — but only the
  // label. What the row did is not restated in the state's colour.
  test("the label reads the state too, and the subject never does", () => {
    const running = paintTool({ ...view, labelTone: undefined }, true);
    expect(running.querySelector(".float-left")?.innerHTML).toContain(
      "text-amber-400"
    );
    expect(running.querySelector(".break-words")?.innerHTML).not.toContain(
      "text-amber-400"
    );

    const host = mountPoint();
    render(
      () => <ToolCard view={{ ...view, labelTone: undefined }} isError />,
      host
    );
    flush();
    expect(host.querySelector(".float-left")?.innerHTML).toContain(
      "text-rose-400"
    );
  });

  // A view that paints its own label has already said something more specific
  // than "running": a subagent's indigo survives its own run.
  test("a view's own labelTone outranks the state", () => {
    expect(paintTool(view, true).innerHTML).toContain("text-indigo-300");
  });

  test("a body of blank blocks is no body: an unstarted call has no disclosure", () => {
    const host = paintTool(
      { title: [SAMPLES.file], body: [{ kind: "text", text: "" }] },
      true
    );
    expect(host.querySelector("details")).toBeNull();
    // It keeps a mark, in amber, so the row keeps its shape while it waits.
    expect(host.innerHTML).toContain("bg-amber-400");
  });

  /**
   * The one mark a row draws is a promise about what reaching for it does.
   * A caret over a row that opens nothing is a promise nothing keeps, and an
   * empty gutter makes the reader click to find out — so the square says
   * "this is all of it" in the caret's own column, as `▪` does in the TUI.
   *
   * And it is the *only* mark either way: `view.icon` is `edit` here and
   * paints nothing, because a row's glyph says what it does next, never what
   * kind of tool it was.
   */
  test("the caret is for rows that open, the square for rows that do not", () => {
    const glyphs = (host: HTMLElement) =>
      host.innerHTML.match(/i-griddy-icons:[\w-]+/g) ?? [];

    expect(glyphs(paintTool(view))).toEqual([
      "i-griddy-icons:chevron-right-small-filled",
    ]);
    for (const bodiless of [
      { title: [SAMPLES.file] },
      { title: [SAMPLES.file], summary: [SAMPLES.attachment] },
    ] satisfies readonly ToolView[]) {
      // The delivery draws a download of its own, below; the gutter is the
      // first mark in the row and the only one that answers for it.
      const marks = glyphs(paintTool(bodiless));
      expect(marks[0]).toBe("i-griddy-icons:square-rounded-filled");
      expect(marks).not.toContain("i-griddy-icons:chevron-right-small-filled");
    }
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

  test("labelTone tints the label", () => {
    expect(paintTool(view).innerHTML).toContain("text-indigo-300");
  });

  test("the label falls back to the tool name the wire carried", () => {
    const host = paintTool({ title: [SAMPLES.text] }, false, "bash");
    expect(host.textContent).toStartWith("bash:");
  });

  test("a view with no body renders a head with no disclosure", () => {
    const host = paintTool({ title: [SAMPLES.text] });
    expect(host.querySelector("details")).toBeNull();
  });

  test("splits each apply_patch file into its own collapsed row", () => {
    const host = paintTools("apply_patch", {
      label: "Edit",
      title: [{ kind: "file", path: "a.ts" }, SAMPLES.spans],
      body: [
        SAMPLES.diff,
        {
          kind: "section",
          label: "Write",
          icon: "edit",
          content: [{ kind: "file", path: "b.ts" }, SAMPLES.spans],
        },
        SAMPLES.diff,
        {
          kind: "section",
          label: "Delete",
          icon: "trash",
          content: [{ kind: "file", path: "c.ts" }, SAMPLES.spans],
        },
      ],
    });

    const rows = host.querySelectorAll("article");
    expect(rows).toHaveLength(3);
    expect([...rows].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Edit:a.ts"),
      expect.stringContaining("Write:b.ts"),
      expect.stringContaining("Delete:c.ts"),
    ]);
    expect(rows[0]?.querySelector("details")?.open).toBe(false);
    expect(rows[1]?.querySelector("details")?.open).toBe(false);
    expect(rows[2]?.querySelector("details")).toBeNull();
  });

  /**
   * A streaming call redraws on every delta, and a row that remounts on one
   * shuts itself in the reader's hands: the disclosure they opened to watch
   * the output is the first thing a rebuild throws away.
   */
  test("a view update redraws the row in place, so an open row stays open", () => {
    const [view, setView] = createSignal<ToolView>({
      label: "Bash",
      title: [{ kind: "text", text: "ls" }],
      body: [{ kind: "text", text: "one" }],
    });
    const host = mountPoint();
    render(() => <ToolCards view={view()} name="bash" isPartial />, host);
    flush();

    const details = host.querySelector("details")!;
    details.open = true;
    setView((current) => ({
      ...current,
      body: [{ kind: "text", text: "one\ntwo" }],
    }));
    flush();

    expect(host.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("two");
  });

  test("keeps sections in non-patch tools inside their one row", () => {
    const host = paintTools("edit", {
      title: [{ kind: "file", path: "a.ts" }],
      body: [SAMPLES.section],
    });

    expect(host.querySelectorAll("article")).toHaveLength(1);
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

  test("an error stays closed, and opens onto the whole failure", () => {
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
    expect(host.textContent).toContain("line 0");
    expect(host.textContent).toContain("line 13");
    expect(host.textContent).not.toContain("more lines");
  });

  test("a failure with nothing to show still reads as one", () => {
    const host = mountPoint();
    render(
      () => (
        <ToolCard view={{ label: "Edit", title: [SAMPLES.file] }} isError />
      ),
      host
    );
    flush();

    expect(host.querySelector("details")).toBeNull();
    expect(host.innerHTML).toContain("bg-rose-400");
  });
});
