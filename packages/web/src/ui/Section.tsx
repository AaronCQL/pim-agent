import type { Element } from "solid-js";

const TITLE = "text-xs font-bold uppercase tracking-widest text-neutral-500";

export function Section(props: {
  readonly title: string;
  readonly children: Element;
}) {
  return (
    <section class="space-y-2">
      <h2 class={TITLE}>{props.title}</h2>
      {props.children}
    </section>
  );
}
