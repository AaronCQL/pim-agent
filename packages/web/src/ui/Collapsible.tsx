import type { Element } from "solid-js";

/**
 * The disclosure glyph on its own, for the one row that has to draw it without
 * a disclosure behind it: a call still in flight, which is shaped like every
 * other tool row but has nothing to open yet.
 *
 * The glyph is 1ch tall in a `--line` tall row, so it centres itself with
 * margins and hangs from the top of the row rather than being centred in it:
 * a wrapped title — a multi-line shell command — is several lines tall, and
 * the caret belongs beside the *first* of them.
 */
export function Caret(props: { readonly class?: string }) {
  return (
    <span
      class={`i-griddy-icons:chevron-right-small-filled mr-1ch my-[calc((var(--line)-1ch)/2)] size-1ch shrink-0 scale-175 ${props.class ?? "bg-neutral-300"}`}
      aria-hidden="true"
    />
  );
}

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
 * An open disclosure hangs behind a left rule whose maths is the mockup's: the
 * rule is centred on the caret's column at `0.5ch`, and the body's first
 * column lands at `2ch`, under the summary's text.
 *
 * The rule is one absolutely positioned spine rather than a border on the
 * body, so a summary tall enough to wrap — a four-line shell command — is
 * threaded by it too, and every open row reads as one thing hanging off its
 * caret instead of a head with a separate bracketed payload. It starts one
 * `--line` down, clear of the caret: the glyph is scaled past its own box and
 * a spine drawn to the caret's centre cuts through it, where one that stops
 * short reads as hanging from it. A closed row draws no spine at all: the
 * rule is what an open disclosure looks like, and a rule leading to nothing
 * would promise a payload that is not there.
 *
 * The hit target is the whole summary row, which is far wider than 44px; the
 * caret is not padded to that height, because a 44px row would push every
 * tool call off the `--line` grid the transcript is built on.
 *
 * The row aligns to its top so that a summary tall enough to wrap keeps the
 * caret on its first line; every item on the row shares the `--line` leading,
 * so a one-line summary looks exactly as it did centred.
 */
export function Collapsible(props: {
  readonly summary: Element;
  readonly open?: boolean;
  readonly caret?: string;
  /** Tints the spine; a `bg-`, since the spine is a box, not a border. */
  readonly spine?: string;
  readonly children: Element;
}) {
  return (
    <details class="group relative min-w-0" open={props.open === true}>
      <summary class="flex min-w-0 cursor-pointer list-none items-start">
        <Caret
          class={`transition-transform group-open:rotate-90 ${props.caret ?? "bg-neutral-300"}`}
        />
        {props.summary}
      </summary>
      <span
        class={`absolute bottom-0 left-[calc(0.5ch-0.75px)] top-[--line] hidden w-1.5px group-open:block ${props.spine ?? "bg-neutral-750"}`}
        aria-hidden="true"
      />
      <div class="ml-2ch min-w-0">{props.children}</div>
    </details>
  );
}
