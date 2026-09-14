import { Show, untrack, type Element } from "solid-js";

const CHEVRON = "i-griddy-icons:chevron-right-small-filled";

/**
 * The caret of a disclosure that stands in its own row rather than the
 * transcript's gutter: read at text size, so the full triangle rather than the
 * gutter's small one blown up.
 */
const ROW_CHEVRON = "i-griddy-icons:chevron-right-filled";

/** What a caret does when the disclosure it stands on opens. */
const TURN = "transition-transform group-open:rotate-90";

export function Caret(props: { readonly class?: string }) {
  return (
    <Glyph
      icon={CHEVRON}
      class={`scale-175 ${props.class ?? "bg-neutral-300"}`}
    />
  );
}

/** The gutter mark of a row that opens onto nothing. */
export function Marker(props: { readonly class?: string }) {
  return (
    <Glyph
      icon="i-griddy-icons:square-rounded-filled"
      class={`scale-75 ${props.class ?? "bg-neutral-300"}`}
    />
  );
}

function Glyph(props: { readonly icon: string; readonly class: string }) {
  return (
    <span
      class={`${props.icon} absolute left-0 top-0 my-[calc((var(--line)-1ch)/2)] size-1ch ${props.class}`}
      aria-hidden="true"
    />
  );
}

/** The rule under the gutter mark; `grip` marks it as a second handle on a `<summary>`. */
export function Spine(props: {
  readonly class?: string;
  readonly grip?: boolean;
}) {
  return (
    <span
      class={`absolute bottom-0 left-0 top-[--line] w-2ch ${props.grip === true ? "cursor-pointer" : ""} ${props.class ?? "text-neutral-750 group-hover:text-neutral-500"}`}
      aria-hidden="true"
    >
      <span class="absolute inset-y-0 left-[calc(0.5ch-0.75px)] w-1.5px bg-current" />
    </span>
  );
}

/** The one wrapper for hiding a payload behind a disclosure; nothing outside `ui/` writes `<details>` directly. */
export function Collapsible(props: {
  readonly summary: Element;
  readonly open?: boolean;
  readonly caret?: string;
  readonly spine?: string;
  /** False takes the disclosure out of the transcript's gutter: the caret joins the summary's own row, and nothing is spined. */
  readonly gutter?: boolean;
  readonly summaryClass?: string;
  /**
   * Said when the reader moves the disclosure off `open`, which is the only
   * change `open` does not already know about: a controlled caller follows it
   * back. Never said for a state this component was given.
   */
  readonly onToggle?: (open: boolean) => void;
  readonly children: Element;
}) {
  const gutter = (): boolean => props.gutter !== false;
  return (
    <details
      class={`group relative min-w-0 ${gutter() ? "pl-2ch" : ""}`}
      open={props.open === true}
      onToggle={(event: Event) => {
        const open = (event.currentTarget as HTMLDetailsElement).open;
        // The browser says `toggle` for a prop written into the element too,
        // from inside the render that wrote it — where nothing may write back.
        // Untracked: what was asked for is a snapshot, not a dependency.
        if (open !== untrack(() => props.open === true)) {
          props.onToggle?.(open);
        }
      }}
    >
      <summary
        class={`min-w-0 cursor-pointer list-none ${props.summaryClass ?? "flow-root"}`}
      >
        <Show
          when={gutter()}
          fallback={
            <span
              class={`${ROW_CHEVRON} ${TURN} size-3 shrink-0 ${props.caret ?? "bg-neutral-400"}`}
              aria-hidden="true"
            />
          }
        >
          <Caret class={`${TURN} ${props.caret ?? "bg-neutral-300"}`} />
          <Spine class={props.spine} grip />
        </Show>
        {props.summary}
      </summary>
      <div class="min-w-0">{props.children}</div>
    </details>
  );
}
