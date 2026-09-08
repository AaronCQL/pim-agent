import { render } from "@solidjs/web";
import { createEffect, onCleanup, untrack } from "solid-js";
import * as smd from "streaming-markdown";

import { Languages } from "#core/shared/Languages";
import { copyText } from "../ui/clipboard";
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
 * The parser's renderer, with every link pointed out of the page. A
 * transcript is a session in flight — one that is still streaming into this
 * tab — so navigating it away is never what a reader meant by following a
 * reference, and `noopener` keeps whatever opens from reaching back through
 * `window.opener`.
 *
 * Marked as the anchor is created rather than swept up afterwards: the parser
 * hands each node over exactly once, and the href it fills in later does not
 * change who opens it.
 */
function renderer(host: HTMLElement): smd.Default_Renderer {
  const base = smd.default_renderer(host);
  return {
    ...base,
    add_token: (data, type) => {
      base.add_token(data, type);
      const node = data.nodes[data.index];
      if (node?.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener");
      }
    },
  };
}

/**
 * The copy, and the flash that is the only report of it: a toast announcing a
 * word's worth of clipboard is louder than the thing it reports, and it would
 * cover the transcript to say it. The attribute is what CSS animates, and it
 * is dropped again when the animation ends rather than on a timer that would
 * have to be kept equal to it.
 */
async function copyInline(code: Element): Promise<void> {
  if (!(await copyText(code.textContent ?? ""))) {
    // A refused clipboard is not worth a message over one token of text.
    return;
  }
  code.removeAttribute("data-copied");
  // Reading layout resolves the removal on its own, so a second click on a
  // token still lit replays the flash instead of vanishing into it.
  code.getBoundingClientRect();
  code.addEventListener(
    "animationend",
    () => {
      code.removeAttribute("data-copied");
    },
    { once: true }
  );
  code.setAttribute("data-copied", "");
}

/**
 * Inline code is nearly always something meant to end up somewhere else — a
 * path, a flag, a command, a symbol — so a click on it copies it, and picking
 * one token out of a sentence by hand, which on a phone is a fight, stops
 * being how you get it. Anything that already answers a click keeps its own
 * answer: a fence has a copy button, and a link navigates.
 *
 * One listener on the host rather than one per token, because this DOM is the
 * parser's — it grows append-only while a message streams, and a diverging
 * message rebuilds it from scratch — so there is no moment at which every
 * token could be found and bound.
 */
function onCodeClick(event: MouseEvent): void {
  const from = event.target;
  if (!(from instanceof Element)) {
    return;
  }
  const code = from.closest("code");
  if (code === null || code.closest("pre, a") !== null) {
    return;
  }
  // A click that ends a drag is where a selection stopped, not a request to
  // replace what the reader was in the middle of selecting.
  if (window.getSelection()?.isCollapsed === false) {
    return;
  }
  void copyInline(code);
}

/**
 * A copy button per finished code block. The parser owns this DOM and knows
 * nothing of components, so the button is mounted afterwards rather than
 * rendered with the block — and only once the block is closed, so it never
 * offers half a payload. The wrapper is what the absolute position resolves
 * against: `<pre>` scrolls, and a button inside it would slide off with the
 * code.
 */
function mountCopyButtons(
  host: HTMLElement,
  open: Element | undefined,
  disposers: (() => void)[]
): void {
  for (const pre of host.querySelectorAll("pre:not([data-copy])")) {
    if (pre === open) {
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
function highlightFences(host: HTMLElement, open: Element | undefined): void {
  for (const code of host.querySelectorAll("pre > code:not([data-hl])")) {
    if (code.parentElement === open) {
      continue;
    }

    const lang = Languages.resolve(code.className);
    // Untracked because the subscription is already held where it can act:
    // the effect below tracks the grammar generation and repaints every
    // fence, and this runs from its callback, where nothing is listening.
    const lines = untrack(() =>
      Highlight.tokenize(code.textContent ?? "", lang)
    );
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
  const disposers: (() => void)[] = [];
  const disposeButtons = (): void => {
    for (const dispose of disposers) {
      dispose();
    }
    disposers.length = 0;
  };
  /** The grammar generation the fences on screen were painted against. */
  let painted = untrack(Highlight.version);

  onCleanup(disposeButtons);

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
        host.replaceChildren();
        parser = smd.parser(renderer(host));
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
      const open = complete ? undefined : openBlock(host);
      highlightFences(host, open);
      mountCopyButtons(host, open, disposers);
    }
  );

  return (
    <div
      ref={(element) => {
        host = element;
      }}
      onClick={onCodeClick}
      class="pim-markdown min-w-0 break-words"
    />
  );
}
