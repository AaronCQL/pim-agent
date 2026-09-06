import { render } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import * as smd from "streaming-markdown";

import { Languages } from "#core/shared/Languages";
import { CopyButton } from "../ui/CopyButton";
import { Highlight } from "../view/highlight";
import { syntaxClass } from "../view/tokens";

/**
 * The `<pre>` the parser may still append to: it is always the deepest last
 * element, since markdown only ever grows at its tail. Everything before it
 * is finished and can be decorated.
 */
function openBlock(host: HTMLElement): Element | undefined {
  let node = host.lastElementChild;
  while (node !== null) {
    if (node.tagName === "PRE") {
      return node;
    }
    node = node.lastElementChild;
  }
  return undefined;
}

/**
 * A copy button per finished code block. The parser owns this DOM and knows
 * nothing of components, so the button is mounted afterwards rather than
 * rendered with the block — and only once the block is closed, so it never
 * offers half a payload. The wrapper is what the absolute position resolves
 * against: `<pre>` scrolls, and a button inside it would slide off with the
 * code.
 */
function mountCopyButtons(host: HTMLElement, complete: boolean): () => void {
  const skip = complete ? undefined : openBlock(host);
  const disposers: (() => void)[] = [];
  for (const pre of host.querySelectorAll("pre:not([data-copy])")) {
    if (pre === skip) {
      continue;
    }
    pre.setAttribute("data-copy", "");
    const wrapper = document.createElement("div");
    wrapper.className = "relative";
    pre.replaceWith(wrapper);
    wrapper.append(pre);
    disposers.push(
      render(
        () => (
          <CopyButton
            text={() => pre.textContent ?? ""}
            label="Copy code"
            class="absolute right-0 top-0"
          />
        ),
        wrapper
      )
    );
  }
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

/**
 * Syntax highlighting for a fence, on the same rule the copy button follows:
 * only once the block has closed. The parser writes this DOM append-only and
 * never repaints it — which is why it can stream at all — so a fence cannot
 * be coloured while it is still growing without fighting it. A finished one
 * is also the only one worth colouring: half a line of TypeScript tokenises
 * as something it is about to stop being.
 *
 * The parser puts the fence language in the `<code>` class, which the fence
 * markers in CSS also read, so the marker here is a `data-` attribute and the
 * class is left exactly as it was found.
 */
function highlightFences(host: HTMLElement, complete: boolean): void {
  const skip = complete ? undefined : openBlock(host);

  for (const code of host.querySelectorAll("pre > code:not([data-hl])")) {
    if (code.parentElement === skip) {
      continue;
    }

    const lang = Languages.resolve(code.className);
    const lines = Highlight.tokenize(code.textContent ?? "", lang);
    code.setAttribute("data-hl", "");
    code.replaceChildren(
      ...lines.flatMap((tokens, index) => {
        const spans = tokens.map((token) => {
          const span = document.createElement("span");
          span.className = syntaxClass(token.role);
          span.textContent = token.text;
          return span;
        });
        return index === 0 ? spans : [document.createTextNode("\n"), ...spans];
      })
    );
  }
}

/**
 * Markdown, rendered by `streaming-markdown`, chosen over the re-parsing
 * renderers (marked, markdown-it, micromark) by measuring partial input: they
 * re-parse the whole prefix on every chunk, so a growing message repaints what
 * is already on screen. This one writes into the DOM append-only, and raw HTML
 * can never escape into it.
 *
 * Only the appended suffix is handed to the parser. Text that shrinks or
 * diverges from what was already written can only be a different message, so
 * the element is rebuilt from scratch.
 *
 * `complete` is what flushes: mid-stream the parser deliberately withholds a
 * trailing token it cannot yet disambiguate (a lone `#`, a half-typed fence
 * language), and that is exactly why it never has to repaint.
 */
export function Markdown(props: {
  readonly text: string;
  readonly complete?: boolean;
}) {
  let host!: HTMLDivElement;
  let written = "";
  let parser: smd.Parser | undefined;
  let disposeButtons = (): void => {};
  /** The grammar generation the fences on screen were painted against. */
  let painted = Highlight.version();

  onCleanup(() => {
    disposeButtons();
  });

  createEffect(
    () => ({
      text: props.text,
      complete: props.complete !== false,
      // A grammar arriving is a repaint: every fence painted plain while it
      // was still loading is offered to the highlighter again.
      grammars: Highlight.version(),
    }),
    ({ text, complete, grammars }) => {
      if (parser === undefined || !text.startsWith(written)) {
        disposeButtons();
        disposeButtons = () => {};
        host.replaceChildren();
        parser = smd.parser(smd.default_renderer(host));
        written = "";
      }
      smd.parser_write(parser, text.slice(written.length));
      written = text;
      if (complete) {
        smd.parser_end(parser);
        parser = undefined;
      }
      if (grammars !== painted) {
        painted = grammars;
        for (const code of host.querySelectorAll("code[data-hl]")) {
          code.removeAttribute("data-hl");
        }
      }
      highlightFences(host, complete);
      const disposeAdded = mountCopyButtons(host, complete);
      const disposePrevious = disposeButtons;
      disposeButtons = () => {
        disposePrevious();
        disposeAdded();
      };
    }
  );

  return (
    <div
      ref={(element) => {
        host = element;
      }}
      class="pim-markdown min-w-0 break-words"
    />
  );
}
