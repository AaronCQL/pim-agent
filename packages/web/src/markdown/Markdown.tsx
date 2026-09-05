import { createEffect } from "solid-js";
import * as smd from "streaming-markdown";

/**
 * Markdown, rendered by `streaming-markdown` — chosen in
 * `renderer-choice.test.ts` by measuring partial input rather than by
 * reputation. It writes into the DOM append-only, so growing `text` never
 * repaints what is already on screen, and raw HTML can never escape into it.
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

  createEffect(
    () => ({ text: props.text, complete: props.complete !== false }),
    ({ text, complete }) => {
      if (parser === undefined || !text.startsWith(written)) {
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
