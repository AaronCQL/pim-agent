import { render } from "@solidjs/web";
import { createEffect, onCleanup, untrack } from "solid-js";
import * as smd from "streaming-markdown";

import { Languages } from "#core/shared/Languages";
import { copyText } from "../ui/clipboard";
import { CopyButton } from "../ui/CopyButton";
import { Highlight } from "../view/highlight";
import { syntaxClass } from "../view/tokens";

// The `<pre>` the parser may still append to: markdown only grows at its tail.
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

// Links open out of the page: `target=_blank` and `noopener`, set as each anchor arrives.
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

async function copyInline(code: Element): Promise<void> {
  if (!(await copyText(code.textContent ?? ""))) {
    return;
  }
  code.removeAttribute("data-copied");
  // Force layout so a second click on a still-lit token replays the flash.
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

// One delegated listener: the parser owns this DOM and rewrites it, so no token
// can be bound individually.
function onCodeClick(event: MouseEvent): void {
  const from = event.target;
  if (!(from instanceof Element)) {
    return;
  }
  const code = from.closest("code");
  if (code === null || code.closest("pre, a") !== null) {
    return;
  }
  // A click that ends a drag is a selection, not a copy request.
  if (window.getSelection()?.isCollapsed === false) {
    return;
  }
  void copyInline(code);
}

// Only closed blocks, and in a wrapper: `<pre>` scrolls, and a button inside it
// would slide off with the code.
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

// Closed fences only: the parser never repaints, and half a line tokenises wrong.
// Marked with `data-hl` rather than a class, which carries the fence language.
function highlightFences(host: HTMLElement, open: Element | undefined): void {
  for (const code of host.querySelectorAll("pre > code:not([data-hl])")) {
    if (code.parentElement === open) {
      continue;
    }

    const lang = Languages.resolve(code.className);
    // Untracked: the effect below already tracks the grammar generation.
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
 * Markdown rendered by `streaming-markdown`: only the appended suffix is
 * parsed, text that diverges rebuilds the element, and `complete` flushes the
 * token the parser withholds mid-stream.
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
  let painted = untrack(Highlight.version);

  onCleanup(disposeButtons);

  createEffect(
    () => ({
      text: props.text,
      complete: props.complete !== false,
      // A grammar arriving repaints every fence painted plain without it.
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
