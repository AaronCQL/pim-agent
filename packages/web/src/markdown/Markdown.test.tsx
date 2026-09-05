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
    write: (next: string) => {
      setText(next);
      flush();
    },
  };
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
});
