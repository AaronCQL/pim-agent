import type { Element } from "solid-js";

export function Caret(props: { readonly class?: string }) {
  return (
    <Glyph
      icon="i-griddy-icons:chevron-right-small-filled"
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
  readonly children: Element;
}) {
  return (
    <details class="group relative min-w-0 pl-2ch" open={props.open === true}>
      <summary class="min-w-0 flow-root cursor-pointer list-none">
        <Caret
          class={`transition-transform group-open:rotate-90 ${props.caret ?? "bg-neutral-300"}`}
        />
        <Spine class={props.spine} grip />
        {props.summary}
      </summary>
      <div class="min-w-0">{props.children}</div>
    </details>
  );
}
