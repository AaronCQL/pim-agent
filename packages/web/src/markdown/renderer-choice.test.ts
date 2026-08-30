import "../test/dom";

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { marked } from "marked";
import MarkdownIt from "markdown-it";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import * as smd from "streaming-markdown";

/**
 * Build-order step 0 of Phase 5: the markdown renderer is chosen by measuring
 * partial input, not by reputation. This file is that experiment, kept
 * runnable so the decision can be re-checked when a candidate ships a major.
 *
 * Run it alone to print the comparison table:
 *   bun test packages/web/src/markdown/renderer-choice.test.ts
 */

type Candidate = {
  readonly name: string;
  /** HTML after each successive chunk, oldest first. */
  readonly stream: (chunks: readonly string[]) => readonly string[];
};

/** A renderer with no streaming entry point re-parses the whole prefix. */
function reparsing(
  name: string,
  render: (source: string) => string
): Candidate {
  return {
    name,
    stream: (chunks) => {
      const frames: string[] = [];
      let source = "";
      for (const chunk of chunks) {
        source += chunk;
        frames.push(render(source));
      }
      return frames;
    },
  };
}

const markdownIt = new MarkdownIt({ html: false, linkify: true });

const CANDIDATES = [
  reparsing("marked", (source) => marked.parse(source, { async: false })),
  reparsing("markdown-it", (source) => markdownIt.render(source)),
  reparsing("micromark", (source) =>
    micromark(source, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    })
  ),
  {
    name: "streaming-markdown",
    stream: (chunks) => {
      const sink = new HtmlSink();
      const parser = smd.parser(sink.renderer());
      const frames: string[] = [];
      for (const chunk of chunks) {
        smd.parser_write(parser, chunk);
        frames.push(sink.html());
      }
      smd.parser_end(parser);
      return frames;
    },
  },
] as const satisfies readonly Candidate[];

const STREAMING = CANDIDATES[3];

/**
 * Documents streamed to completion. Every intermediate prefix is a partial
 * parse, so churn here is exactly the flicker a reader would see.
 */
const STREAMED = [
  { name: "fence", text: "Result:\n\n```ts\nconst a = 1;\n```\n" },
  { name: "table", text: "| file | lines |\n| --- | --- |\n| a.ts | 12 |\n" },
  { name: "link", text: "See [the docs](https://example.com) now.\n" },
  { name: "emphasis", text: "This is **bold** and *italic* text.\n" },
  { name: "heading", text: "# Title\n\nBody paragraph.\n" },
  { name: "list", text: "- one\n- two\n\n1. a\n2. b\n" },
] as const;

/** Prefixes that never complete: the turn was cut off mid-token. */
const TRUNCATED = [
  { name: "unclosed fence", text: "Result:\n\n```ts\nconst a = 1;\nconst b" },
  { name: "half-typed lang", text: "Here:\n\n```typescr" },
  { name: "half table", text: "| file | lines |\n| --- | --- |\n| a.ts" },
  { name: "truncated link", text: "See [the docs](https://exa" },
  { name: "open emphasis", text: "This is **bold and *ital" },
  { name: "lone hash", text: "#" },
] as const;

const CASES = [...STREAMED, ...TRUNCATED];

const PERF_DOC = [
  "# Report\n\nRan the **suite** against `main` and found _three_ regressions.\n\n",
  "| case | status |\n| --- | --- |\n| parse | ok |\n| render | slow |\n\n",
  "```ts\nexport function slow(n: number) {\n  return n ** 2;\n}\n```\n\n",
  "1. Fix [the memo](https://example.com/memo)\n2. Re-run\n3. Ship\n\n",
  "> Blockquote with ~~strike~~ and a trailing note.\n",
].join("");

type Report = {
  readonly threw: boolean;
  readonly textChurn: number;
  readonly structureChurn: number;
};

/** Roughly one token: enough to land mid-fence, mid-URL and mid-`**`. */
function tokenize(text: string): readonly string[] {
  return text.match(/[\s\S]{1,4}/g) ?? [];
}

function tags(html: string): readonly string[] {
  return [...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((match) =>
    (match[1] ?? "").toLowerCase()
  );
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isPrefix(
  before: readonly string[],
  after: readonly string[]
): boolean {
  return before.every((item, index) => after[index] === item);
}

/**
 * Flicker, made measurable: text already on screen should stay on screen, and
 * the elements already opened should still be the outer ones. A step that
 * violates either repaints something the reader was already looking at.
 */
function measure(candidate: Candidate, text: string): Report {
  let frames: readonly string[];
  try {
    frames = candidate.stream(tokenize(text));
  } catch {
    return { threw: true, textChurn: 0, structureChurn: 0 };
  }

  let textChurn = 0;
  let structureChurn = 0;
  for (let index = 1; index < frames.length; index++) {
    const before = frames[index - 1] ?? "";
    const after = frames[index] ?? "";
    if (!visibleText(after).startsWith(visibleText(before))) {
      textChurn++;
    }
    if (!isPrefix(tags(before), tags(after))) {
      structureChurn++;
    }
  }
  return { threw: false, textChurn, structureChurn };
}

/** Cost of one streamed frame on a realistic turn, averaged over the doc. */
function msPerFrame(candidate: Candidate): number {
  const chunks = tokenize(PERF_DOC);
  candidate.stream(chunks);
  const runs = 5;
  const started = Bun.nanoseconds();
  for (let run = 0; run < runs; run++) {
    candidate.stream(chunks);
  }
  return (Bun.nanoseconds() - started) / 1e6 / (runs * chunks.length);
}

async function versionOf(name: string): Promise<string> {
  const manifest = await Bun.file(
    join(import.meta.dir, "../../../../node_modules", name, "package.json")
  ).json();
  return String(manifest.version);
}

describe("markdown renderer choice", () => {
  test("no candidate throws on any partial input", () => {
    for (const candidate of CANDIDATES) {
      for (const testCase of CASES) {
        const label = `${candidate.name}/${testCase.name}`;
        expect(
          `${label} threw=${measure(candidate, testCase.text).threw}`
        ).toBe(`${label} threw=false`);
      }
    }
  });

  test("comparison table", async () => {
    const rows = [
      ["candidate".padEnd(30), ...CASES.map((c) => cell(c))].join(""),
    ];
    const shapes = [
      ["candidate".padEnd(30), ...TRUNCATED.map((c) => cell(c, 38))].join(""),
      "-".repeat(30 + TRUNCATED.length * 38),
    ];
    for (const candidate of CANDIDATES) {
      const label = `${candidate.name}@${await versionOf(candidate.name)}`;
      rows.push(
        [
          label.padEnd(30),
          ...CASES.map((testCase) => {
            const report = measure(candidate, testCase.text);
            return cell(`${report.textChurn}/${report.structureChurn}`);
          }),
          `${msPerFrame(candidate).toFixed(3)} ms/frame`,
        ].join("")
      );
      shapes.push(
        `${label.padEnd(30)}${TRUNCATED.map((testCase) =>
          cell(shapeOf(candidate, testCase.text), 38)
        ).join("")}`
      );
    }
    console.log(
      [
        "",
        "streamed-to-completion + truncated churn — textChurn/structureChurn, lower is better",
        ...rows,
        "",
        "final element outline of each truncated case",
        ...shapes,
        "",
      ].join("\n")
    );
    expect(rows).toHaveLength(CANDIDATES.length + 1);
  });

  test("only streaming-markdown never repaints settled output", () => {
    for (const testCase of CASES) {
      const report = measure(STREAMING, testCase.text);
      expect(`${testCase.name} ${report.structureChurn} ${report.textChurn}`) //
        .toBe(`${testCase.name} 0 0`);
    }
  });

  test("every re-parsing candidate repaints while streaming", () => {
    for (const candidate of CANDIDATES.slice(0, 3)) {
      const churn = STREAMED.reduce(
        (total, testCase) =>
          total + measure(candidate, testCase.text).structureChurn,
        0
      );
      expect(`${candidate.name} ${churn > 0}`).toBe(`${candidate.name} true`);
    }
  });

  test("streaming-markdown opens a code block before the fence closes", () => {
    const frames = STREAMING.stream(tokenize("```ts\nconst a = 1;"));
    expect(frames.at(-1)).toBe(
      '<pre><code class="ts">const a = 1</code></pre>'
    );
  });

  /** Withheld, not guessed: it cannot know the tag is finished, so it waits. */
  test("streaming-markdown emits nothing for a half-typed language tag", () => {
    expect(STREAMING.stream(tokenize("```typescr")).at(-1)).toBe("");
  });

  test("streaming-markdown escapes raw HTML", () => {
    const frames = STREAMING.stream(['<img src=x onerror="alert(1)">']);
    expect(frames.at(-1)).not.toContain("<img");
  });
});

function cell(value: string | { readonly name: string }, width = 18): string {
  return (typeof value === "string" ? value : value.name).padEnd(width);
}

/** The element outline a truncated document lands on, e.g. `pre>code`. */
function shapeOf(candidate: Candidate, text: string): string {
  const last = candidate.stream(tokenize(text)).at(-1) ?? "";
  const outline = tags(last).join(">");
  return outline === "" ? "(empty)" : outline;
}

type Node = {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly children: Array<Node | string>;
  readonly parent: Node | undefined;
};

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

const TAGS: Record<number, string> = {
  [smd.Token.Blockquote]: "blockquote",
  [smd.Token.Paragraph]: "p",
  [smd.Token.Line_Break]: "br",
  [smd.Token.Rule]: "hr",
  [smd.Token.Heading_1]: "h1",
  [smd.Token.Heading_2]: "h2",
  [smd.Token.Heading_3]: "h3",
  [smd.Token.Heading_4]: "h4",
  [smd.Token.Heading_5]: "h5",
  [smd.Token.Heading_6]: "h6",
  [smd.Token.Italic_Ast]: "em",
  [smd.Token.Italic_Und]: "em",
  [smd.Token.Strong_Ast]: "strong",
  [smd.Token.Strong_Und]: "strong",
  [smd.Token.Strike]: "s",
  [smd.Token.Code_Inline]: "code",
  [smd.Token.Link]: "a",
  [smd.Token.Raw_URL]: "a",
  [smd.Token.Image]: "img",
  [smd.Token.List_Unordered]: "ul",
  [smd.Token.List_Ordered]: "ol",
  [smd.Token.List_Item]: "li",
  [smd.Token.Checkbox]: "input",
  [smd.Token.Table]: "table",
  [smd.Token.Equation_Block]: "equation-block",
  [smd.Token.Equation_Inline]: "equation-inline",
};

/**
 * A string-emitting mirror of `smd.default_renderer`, so the experiment can
 * snapshot the incremental DOM without pulling a DOM shim into `bun test`.
 * Only the shapes the default renderer builds — `pre > code`, `thead`/`tbody`,
 * `th` vs `td` — are special-cased.
 */
class HtmlSink {
  private readonly root: Node = {
    tag: "#root",
    attrs: new Map(),
    children: [],
    parent: undefined,
  };
  private open: Node = this.root;

  public renderer(): smd.Renderer<undefined> {
    return {
      data: undefined,
      add_token: (_data: undefined, type: smd.Token) => this.addToken(type),
      end_token: () => {
        this.open = this.open.parent ?? this.root;
      },
      add_text: (_data: undefined, text: string) => {
        this.open.children.push(text);
      },
      set_attr: (_data: undefined, type: smd.Attr, value: string) => {
        this.open.attrs.set(smd.attr_to_html_attr(type), value);
      },
    };
  }

  public html(): string {
    return this.root.children.map(serialize).join("");
  }

  private addToken(type: number): void {
    if (type === smd.Token.Document) {
      return;
    }
    if (type === smd.Token.Code_Block || type === smd.Token.Code_Fence) {
      this.push(this.push(this.open, "pre"), "code");
      return;
    }
    if (type === smd.Token.Table_Row) {
      const section =
        this.open.children.length === 0
          ? this.push(this.open, "thead")
          : ((this.open.children[1] as Node | undefined) ??
            this.push(this.open, "tbody"));
      this.push(section, "tr");
      return;
    }
    if (type === smd.Token.Table_Cell) {
      this.push(this.open, this.open.parent?.tag === "thead" ? "th" : "td");
      return;
    }
    this.push(this.open, TAGS[type] ?? "span");
  }

  /** Appends `tag` under `parent` and makes it the open node. */
  private push(parent: Node, tag: string): Node {
    const node: Node = { tag, attrs: new Map(), children: [], parent };
    parent.children.push(node);
    this.open = node;
    return node;
  }
}

function serialize(node: Node | string): string {
  if (typeof node === "string") {
    return escapeHtml(node);
  }
  const attrs = [...node.attrs]
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
  if (VOID_TAGS.has(node.tag)) {
    return `<${node.tag}${attrs}>`;
  }
  return `<${node.tag}${attrs}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
