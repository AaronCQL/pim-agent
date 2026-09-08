import type { Element } from "solid-js";

/**
 * The disclosure glyph on its own, for the one row that has to draw it without
 * a disclosure behind it: a call still in flight, which is shaped like every
 * other tool row but has nothing to open yet.
 *
 * The caret does not sit *in* the row's text, it sits in the `2ch` gutter the
 * row is indented by — so it is positioned rather than flowed, and its host
 * only has to be `relative` and padded. That is what keeps a wrapped title out
 * of the label's shadow: the text has one left edge, on every line, whether
 * the label is `Bash` or `apply_patch`, exactly as in the terminal, where the
 * marker and the `│` share one three-column gutter.
 *
 * The glyph is 1ch tall in a `--line` tall row, so it centres itself with
 * margins and hangs from the top of the row rather than being centred in it:
 * a wrapped title — a multi-line shell command — is several lines tall, and
 * the caret belongs beside the *first* of them.
 */
export function Caret(props: { readonly class?: string }) {
  return (
    <span
      class={`i-griddy-icons:chevron-right-small-filled absolute left-0 top-0 my-[calc((var(--line)-1ch)/2)] size-1ch scale-175 ${props.class ?? "bg-neutral-300"}`}
      aria-hidden="true"
    />
  );
}

/**
 * The rule under the caret, and the second way to work the disclosure.
 *
 * It is a `2ch` wide handle with a hairline drawn down the caret's column, not
 * a hairline that happens to be clickable: 1.5px is not a hit target, and the
 * gutter is empty anyway. Being inside `<summary>`, the click that opens and
 * closes the row is the platform's own — there is no handler here, and none of
 * the keyboard behaviour is re-implemented.
 *
 * The rule is `bg-current` so one colour class tints it and its hover state
 * together, and the handle is `aria-hidden`: it is a second grip on the
 * control the summary already is, not a control of its own.
 */
function Spine(props: { readonly class?: string }) {
  return (
    <span
      class={`absolute bottom-0 left-0 top-[--line] w-2ch cursor-pointer ${props.class ?? "text-neutral-750 group-hover:text-neutral-500"}`}
      aria-hidden="true"
    >
      <span class="absolute inset-y-0 left-[calc(0.5ch-0.75px)] w-1.5px bg-current" />
    </span>
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
 * `spine` tints the rule, which is painted by `color`, so that class is a
 * `text-` — and it carries its own hover, keyed off the row's `group` rather
 * than the rule's own `:hover`, so that pointing anywhere at the row lights
 * the grip that works it. A failed row has to brighten in rose and a running
 * one in amber, which is why the pair travels together from the caller.
 *
 * The whole disclosure is indented by `2ch` and everything it draws hangs in
 * that gutter: the caret at the top, the rule below it, centred on the caret's
 * column at `0.5ch`. So the summary, the payload and every wrapped line of the
 * summary share one left edge — there is no flex row here, and a long title is
 * not indented by the length of its own label.
 *
 * The rule is one absolutely positioned spine rather than a border on the
 * body, so a summary tall enough to wrap — a four-line shell command — is
 * threaded by it too, and every row reads as one thing hanging off its caret
 * instead of a head with a separate bracketed payload. It starts one `--line`
 * down, clear of the caret: the glyph is scaled past its own box and a spine
 * drawn to the caret's centre cuts through it, where one that stops short
 * reads as hanging from it.
 *
 * That start is also why the spine needs no open/closed state of its own. A
 * closed row whose summary fits on one line is exactly one `--line` tall, so
 * the rule is zero-height and draws nothing; a closed row whose summary wraps
 * draws it beside precisely the lines that overspilled. The rule therefore
 * says "this ink continues the row above", which is true while collapsed and
 * true while open, and the caret is left to say which of the two it is.
 *
 * The hit target is the whole summary row, which is far wider than 44px; the
 * caret is not padded to that height, because a 44px row would push every tool
 * call off the `--line` grid the transcript is built on.
 */
export function Collapsible(props: {
  readonly summary: Element;
  readonly open?: boolean;
  readonly caret?: string;
  /** Tints the spine and its hover; a `text-`, since the rule is `bg-current`. */
  readonly spine?: string;
  readonly children: Element;
}) {
  return (
    <details class="group relative min-w-0 pl-2ch" open={props.open === true}>
      {/* `flow-root`, not the UA's `list-item`: no marker box to suppress, and
          the summary is a run of text the caret sits beside rather than a row
          of columns. It contains its own floats, so the row keeps its full
          height even when a floated label is the tallest thing in it — a call
          whose title has not streamed in yet. */}
      <summary class="min-w-0 flow-root cursor-pointer list-none">
        <Caret
          class={`transition-transform group-open:rotate-90 ${props.caret ?? "bg-neutral-300"}`}
        />
        <Spine class={props.spine} />
        {props.summary}
      </summary>
      <div class="min-w-0">{props.children}</div>
    </details>
  );
}
