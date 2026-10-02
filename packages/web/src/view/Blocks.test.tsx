import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { until } from "#core/shared/fixtures/wait";
import { GatewayOrigin } from "../session/Gateway";
import { mountPoint } from "../test/dom";
import { Blocks } from "./Blocks";
import { ToolCard, ToolCards } from "./ToolCard";
import {
  DIFF_EMPHASIS_CLASSES,
  DIFF_ROW_CLASSES,
  groupByFrame,
  SYNTAX_CLASSES,
} from "./tokens";

const GATEWAY = "http://gateway";

function Painted(props: { readonly blocks: readonly ViewBlock[] }) {
  return (
    <GatewayOrigin value={() => GATEWAY}>
      <Blocks blocks={props.blocks} />
    </GatewayOrigin>
  );
}

function paint(blocks: readonly ViewBlock[]): string {
  const host = mountPoint();
  render(() => <Painted blocks={blocks} />, host);
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
    () => (
      <GatewayOrigin value={() => GATEWAY}>
        <ToolCard view={view} isPartial={isPartial} name={name} />
      </GatewayOrigin>
    ),
    host
  );
  flush();
  return host;
}

function paintTools(name: string, view: ToolView): HTMLElement {
  const host = mountPoint();
  render(() => <ToolCards view={view} name={name} />, host);
  flush();
  return host;
}

/** One block of every kind; the type keeps it exhaustive. */
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
    // The store resolves URLs to absolute ones.
    url: "http://gateway/attachment/s1/revenue-1.png",
    isImage: true,
  },
  image: {
    kind: "image",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    width: 1200,
    height: 800,
    bytes: 245_760,
    alt: "docs/shot.png",
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

  test("adjacent spans carry no spacing of their own", () => {
    const host = mountPoint();
    render(() => <Painted blocks={[SAMPLES.spans]} />, host);
    flush();
    expect(host.textContent).toBe("+2/-1");
  });

  test("a list recurses into nested blocks", () => {
    const html = paint([SAMPLES.list]);
    expect(html).toContain("<ol");
    expect(html).toContain("nested");
  });

  test("an image attachment paints a picture and a way to keep it", () => {
    const host = mountPoint();
    render(() => <Painted blocks={[SAMPLES.attachment]} />, host);
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

  test("a picture the model read paints a tile that opens full size", () => {
    const host = mountPoint();
    render(() => <Painted blocks={[SAMPLES.image]} />, host);
    flush();

    const image = host.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(
      `${GATEWAY}/image/${SAMPLES.image.sha256}.png`
    );
    expect(image.getAttribute("alt")).toBe("docs/shot.png");
    expect(image.getAttribute("width")).toBe("1200");
    expect(image.getAttribute("height")).toBe("800");
    expect(host.querySelector("a[download]")).toBeNull();

    image
      .closest("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe(
      "docs/shot.png"
    );
  });

  test("an expired picture degrades to its summary, not a broken tile", () => {
    const host = mountPoint();
    render(() => <Painted blocks={[SAMPLES.image]} />, host);
    flush();

    host.querySelector("img")!.dispatchEvent(new Event("error"));
    flush();

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("[image 1200×800 png · 240 KB]");
  });

  test("a section paints its label and recurses into its content", () => {
    const html = paint([SAMPLES.section]);
    // `icon` is deliberately not painted.
    expect(html).not.toContain("i-griddy");
    expect(html).toContain("greeter.ts");
    expect(html).toContain("inner");
  });

  test("a diff paints one flat row per line, gutter included", () => {
    const host = mountPoint();
    render(() => <Painted blocks={[SAMPLES.diff]} />, host);
    flush();

    expect(host.querySelector("details")).toBeNull();
    expect(host.innerHTML).not.toContain("@@");
    expect(host.innerHTML).toContain(DIFF_ROW_CLASSES.added);
    expect(host.innerHTML).toContain(DIFF_ROW_CLASSES.removed);
    expect(host.textContent).toContain(" 2 − old");
    expect(host.textContent).toContain(" 2 + new");
    expect(host.querySelector("div")?.className).toContain("w-max");
  });

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

    await until(() => {
      flush();
      return host.innerHTML.includes(SYNTAX_CLASSES.keyword);
    }, "the ts grammar");

    const keyword = [...host.querySelectorAll("span")].find(
      (node) => node.textContent === "const"
    );
    const changed = [...host.querySelectorAll("span")].filter((node) =>
      node.className.includes(DIFF_EMPHASIS_CLASSES.added)
    );

    expect(keyword?.className).toContain(SYNTAX_CLASSES.keyword);
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

  test("a markdown body keeps full strength", () => {
    const host = paintTool({ ...view, body: [SAMPLES.markdown, SAMPLES.kv] });
    expect(host.querySelector("details > div > div")?.className).toBe("");
  });

  test("a read picture stays in the body, undimmed", () => {
    const host = paintTool({
      label: "Read",
      title: [SAMPLES.file],
      body: [SAMPLES.image, SAMPLES.kv],
    });
    const details = host.querySelector("details")!;
    expect(details.querySelector("img")).not.toBeNull();
    expect(host.querySelector("details > div > div")?.className).toBe("");
    expect(host.querySelector("article")?.className).toContain("opacity-80");
  });

  test("a partial call keeps the body, so output can be watched", () => {
    const host = paintTool(view, true);
    expect(host.querySelector("details")).not.toBeNull();
    expect(host.textContent).toContain("+2");
  });

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

    const plain = paintTool({ ...delivered, summary: [SAMPLES.spans] });
    expect(plain.querySelector("article")?.className).toContain("opacity-80");
  });

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

    expect(spine(paintTool({ title: [SAMPLES.file] }, true))).toContain(
      "text-amber-400"
    );
    expect(paintTool(view).querySelectorAll(RULE)).toHaveLength(1);
  });

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

  test("a view's own labelTone outranks the state", () => {
    expect(paintTool(view, true).innerHTML).toContain("text-indigo-300");
  });

  test("a body of blank blocks is no body: an unstarted call has no disclosure", () => {
    const host = paintTool(
      { title: [SAMPLES.file], body: [{ kind: "text", text: "" }] },
      true
    );
    expect(host.querySelector("details")).toBeNull();
    expect(host.innerHTML).toContain("bg-amber-400");
  });

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
      const marks = glyphs(paintTool(bodiless));
      expect(marks[0]).toBe("i-griddy-icons:square-rounded-filled");
      expect(marks).not.toContain("i-griddy-icons:chevron-right-small-filled");
    }
  });

  test("the label falls back to the tool name the wire carried", () => {
    const host = paintTool({ title: [SAMPLES.text] }, false, "bash");
    expect(host.textContent).toStartWith("bash:");
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
