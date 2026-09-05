import type { Element } from "solid-js";

/**
 * The one wrapper feature code may use to hide a payload behind a disclosure.
 * `<details>`/`<summary>` is the platform primitive: keyboard operation, the
 * open/closed state, and find-in-page all come free, and no component library
 * is involved.
 *
 * Nothing outside `ui/` writes `<details>` directly.
 *
 * The caret is the only glyph a disclosure draws, and it carries state the way
 * the TUI's `▪` marker does — hence `caret`, which tints it. Being a masked
 * icon, the glyph is painted by `background-color`, so that class is a `bg-`.
 *
 * The body hangs behind a left rule whose maths is the mockup's: the rule is
 * centred on the caret at `0.5ch`, half its 1.5px width shaved off the margin
 * and the other half off the padding, so margin + border + padding sums to
 * exactly `2ch` and the body's first column lands under the summary's text.
 *
 * The hit target is the whole summary row, which is far wider than 44px; the
 * caret is not padded to that height, because a 44px row would push every
 * tool call off the `--line` grid the transcript is built on.
 */
export function Collapsible(props: {
  readonly summary: Element;
  readonly open?: boolean;
  readonly caret?: string;
  readonly rule?: string;
  readonly children: Element;
}) {
  return (
    <details class="group min-w-0" open={props.open === true}>
      <summary class="flex min-w-0 cursor-pointer list-none items-center">
        <span
          class={`i-griddy-icons:chevron-right-small-filled mr-1ch size-1ch shrink-0 scale-175 transition-transform group-open:rotate-90 ${props.caret ?? "bg-neutral-300"}`}
          aria-hidden="true"
        />
        {props.summary}
      </summary>
      <div
        class={`ml-[calc(0.5ch-0.75px)] min-w-0 border-l-1.5 pl-[calc(1.5ch-0.75px)] ${props.rule ?? "border-neutral-750"}`}
      >
        {props.children}
      </div>
    </details>
  );
}
