import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { Markdown } from "./Markdown";

function mount(initial: string, complete = true) {
  const [text, setText] = createSignal(initial);
  const host = mountPoint();
  render(() => <Markdown text={text()} complete={complete} />, host);
  flush();
  return {
    html: () => host.querySelector(".pim-markdown")?.innerHTML ?? "",
    text: () => host.textContent ?? "",
    find: (selector: string) => host.querySelector(selector),
    write: (next: string) => {
      setText(next);
      flush();
    },
  };
}

function click(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** A click does not hand back the copy it starts; yield until it has settled. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

describe("Markdown", () => {
  test("renders a completed message in one pass", () => {
    const view = mount("# Title\n\nBody with `code`.\n");
    expect(view.html()).toContain("<h1>Title</h1>");
    expect(view.html()).toContain("<code>code</code>");
  });

  /** Mid-stream the last character is deliberately withheld: it may still turn
   *  out to be part of a token, and holding it is what buys zero repaints. */
  test("a growing message is appended to, never repainted", () => {
    const view = mount("Hello", false);
    expect(view.html()).toBe("<p>Hell</p>");
    view.write("Hello world");
    expect(view.html()).toBe("<p>Hello worl</p>");
  });

  test("completing the message flushes the withheld tail", () => {
    const [host, complete] = [mount("Hello", false), mount("Hello")];
    expect(host.html()).toBe("<p>Hell</p>");
    expect(complete.html()).toBe("<p>Hello</p>");
  });

  test("an unclosed fence still renders as a code block", () => {
    const view = mount("```ts\nconst a = 1;", false);
    expect(view.html()).toContain("<pre>");
    expect(view.html()).toContain('class="ts"');
  });

  /** Withheld, not guessed: the language tag may still be growing, so nothing
   *  is painted until it is known to be finished. */
  test("a half-typed language tag paints nothing at all", () => {
    expect(mount("```typescr", false).html()).toBe("");
  });

  test("text that diverges rebuilds instead of appending", () => {
    const view = mount("first message");
    view.write("second message");
    expect(view.html()).toContain("second message");
    expect(view.html()).not.toContain("first message");
  });

  test("raw HTML never reaches the DOM as markup", () => {
    const view = mount('<img src=x onerror="alert(1)">\n');
    expect(view.html()).not.toContain("<img");
    expect(view.html()).toContain("&lt;img");
  });

  test("a finished code block gets a copy button", () => {
    const view = mount("```ts\nconst a = 1;\n```\n");
    expect(view.html()).toContain('aria-label="Copy code"');
  });

  /** A closing fence is only known to be closed once something follows it, so
   *  mid-stream the button waits rather than offering half a payload. */
  test("a block still being written gets none", () => {
    const view = mount("```ts\nconst a = 1;", false);
    expect(view.html()).not.toContain("Copy code");
    view.write("```ts\nconst a = 1;\n```\n\nand then prose");
    expect(view.html()).toContain('aria-label="Copy code"');
  });

  test("the button is mounted once, however many writes follow", () => {
    const view = mount("```ts\nconst a = 1;\n```\n\ntext", false);
    view.write("```ts\nconst a = 1;\n```\n\ntext and more");
    expect(view.html().match(/aria-label="Copy code"/gu)).toHaveLength(1);
  });

  /**
   * Fences are highlighted on the copy button's rule — only once closed —
   * because the parser owns this DOM and never repaints it. The grammar
   * arrives a tick later, so the block is written plain and coloured in
   * place; what must never change through any of it is the code itself.
   */
  test("a finished fence is syntax highlighted once its grammar lands", async () => {
    const view = mount("```ts\nconst a = 1;\n```\n\nprose\n");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      flush();
      if (view.html().includes("text-fuchsia-300")) {
        break;
      }
      await Bun.sleep(10);
    }

    expect(view.html()).toContain("text-fuchsia-300");
    expect(view.text()).toContain("const a = 1;");
    // The fence markers are drawn from the language class, which stays put.
    expect(view.html()).toContain('class="ts"');
  });

  test("a fence still being written is left plain", () => {
    const view = mount("```ts\nconst a = 1;", false);
    expect(view.html()).not.toContain("data-hl");
  });

  test("links open out of the page and cannot reach back into it", () => {
    const view = mount("See [the docs](https://pi.dev/) for more.\n");
    const link = view.find("a");
    expect(link?.getAttribute("href")).toBe("https://pi.dev/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  /** Anchors are marked as they are created, so one still being written has
   *  them too — the href arrives later and does not change who opens it. */
  test("a link still being written is marked already", () => {
    const view = mount("See [the docs](https://pi.", false);
    expect(view.find("a")?.getAttribute("target")).toBe("_blank");
  });

  test("clicking inline code copies it and flashes it", async () => {
    const view = mount("Run `bun run check` first.\n");
    const code = view.find("code");

    click(code);
    await settle();

    expect(await navigator.clipboard.readText()).toBe("bun run check");
    expect(code?.hasAttribute("data-copied")).toBe(true);
    // The flash is an attribute the CSS animates; the text is untouched.
    expect(view.text()).toContain("Run bun run check first.");
  });

  test("the flash is cleared once it has played", async () => {
    const view = mount("Run `bun run check` first.\n");
    const code = view.find("code");

    click(code);
    await settle();
    code?.dispatchEvent(new Event("animationend"));

    expect(code?.hasAttribute("data-copied")).toBe(false);
  });

  /** A fence answers a click with its own button, and a link navigates. */
  test("code that already answers a click is left alone", async () => {
    await navigator.clipboard.writeText("untouched");
    const view = mount(
      "```ts\nconst a = 1;\n```\n\n[`a link`](https://pi.dev/)\n"
    );

    click(view.find("pre code"));
    click(view.find("a code"));
    await settle();

    expect(await navigator.clipboard.readText()).toBe("untouched");
  });

  /** A click that ends a drag is where a selection stopped. */
  test("a click that finishes a selection copies nothing", async () => {
    await navigator.clipboard.writeText("untouched");
    const view = mount("Run `bun run check` first.\n");
    const code = view.find("code");
    window.getSelection()?.selectAllChildren(code as Node);

    click(code);
    await settle();

    expect(await navigator.clipboard.readText()).toBe("untouched");
    expect(code?.hasAttribute("data-copied")).toBe(false);
  });
});
