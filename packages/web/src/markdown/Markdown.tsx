import { render } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import * as smd from "streaming-markdown";

import { CopyButton } from "../ui/CopyButton";

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

  onCleanup(() => {
    disposeButtons();
  });

  createEffect(
    () => ({ text: props.text, complete: props.complete !== false }),
    ({ text, complete }) => {
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
