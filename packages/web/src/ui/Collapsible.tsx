import type { Element } from "solid-js";

/**
 * The one wrapper feature code may use to hide a payload behind a disclosure.
 * `<details>`/`<summary>` is the platform primitive: keyboard operation, the
 * open/closed state, and find-in-page all come free, and no component library
 * is involved.
 *
 * Nothing outside `ui/` writes `<details>` directly.
 */
export function Collapsible(props: {
  readonly summary: Element;
  readonly open?: boolean;
  readonly children: Element;
}) {
  return (
    <details class="group" open={props.open === true}>
      <summary class="flex cursor-pointer list-none items-center gap-1.5">
        <span
          class="i-lucide-chevron-right shrink-0 text-neutral-500 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {props.summary}
      </summary>
      <div class="pl-4">{props.children}</div>
    </details>
  );
}
