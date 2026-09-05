import { Show } from "solid-js";

import type { ToolView } from "#core/view/ViewBlock";
import { Collapsible } from "../ui/Collapsible";
import { Blocks, Body } from "./Blocks";
import { iconClass, toneClass } from "./tokens";

/**
 * One tool row. The `ToolView` contract splits three ways and this is where
 * that split becomes markup:
 *
 * - `title` is the one-line headline, next to `icon` and the `labelTone`-tinted
 *   label. HTML gets to keep the whole path where the ANSI painter shortens to
 *   a basename, because CSS truncation already handles the width.
 * - `summary` renders in every state — streaming, collapsed, expanded — so it
 *   sits outside the disclosure.
 * - `body` is expand-only, and `collapsed: false` forces it open. It is also
 *   dropped entirely while the call is still partial: a half-finished call has
 *   no payload worth an affordance.
 */
export function ToolCard(props: {
  readonly view: ToolView;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  const hasBody = () =>
    props.isPartial !== true && (props.view.body?.length ?? 0) > 0;

  return (
    <article
      class={{
        "rounded border px-2 py-1 text-sm": true,
        "border-neutral-800 bg-neutral-900/40": props.isError !== true,
        "border-red-900/60 bg-red-950/20": props.isError === true,
      }}
    >
      <Show when={hasBody()} fallback={<Head view={props.view} />}>
        <Collapsible
          summary={<Head view={props.view} />}
          open={props.view.collapsed === false}
        >
          <Body blocks={props.view.body ?? []} />
        </Collapsible>
      </Show>
      <Show when={(props.view.summary?.length ?? 0) > 0}>
        <Body blocks={props.view.summary ?? []} />
      </Show>
    </article>
  );
}

function Head(props: { readonly view: ToolView }) {
  return (
    <span class="flex min-w-0 items-baseline gap-1.5 truncate">
      <span
        class={`${iconClass(props.view.icon)} shrink-0 self-center`}
        aria-hidden="true"
      />
      <Show when={props.view.label}>
        <span class={`shrink-0 ${toneClass(props.view.labelTone ?? "title")}`}>
          {props.view.label}
        </span>
      </Show>
      <span class="min-w-0 truncate text-neutral-400">
        <Blocks blocks={props.view.title} />
      </span>
    </span>
  );
}
