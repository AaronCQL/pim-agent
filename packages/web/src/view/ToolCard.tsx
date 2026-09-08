import { createMemo, For, Show } from "solid-js";

import type { Tone, ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Collapsible, Marker, Spine } from "../ui/Collapsible";
import { Blocks, Body } from "./Blocks";
import { caretClass, spineClass, toneClass } from "./tokens";

/** One tool row: a mark, the label and its subject, and an expand-only body. */
export function ToolCard(props: {
  readonly view: ToolView;
  readonly name?: string;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  // Memoised: a partial call re-renders on every delta.
  const body = createMemo(() => (props.view.body ?? []).filter(isDrawn));
  const error = () => props.isError === true;
  const partial = () => props.isPartial === true;
  const caret = () => caretClass(partial(), error());
  const spine = () => spineClass(partial(), error());
  const dimmed = () =>
    !body().some((block) => block.kind === "diff" || block.kind === "markdown");

  const tone = (): Tone | undefined =>
    props.view.labelTone ??
    (error() ? "error" : partial() ? "warning" : undefined);

  const summary = createMemo(() => {
    const blocks = props.view.summary ?? [];
    return {
      status: blocks.filter((block) => block.kind !== "attachment"),
      delivered: blocks.filter((block) => block.kind === "attachment"),
    };
  });

  const head = () => (
    <>
      <Head view={props.view} name={props.name} tone={tone()} />
      <Show when={summary().status.length > 0}>
        <div class="text-neutral-400">
          <Body blocks={summary().status} />
        </div>
      </Show>
    </>
  );

  return (
    <article
      class={`relative min-w-0 ${summary().delivered.length > 0 ? "" : "opacity-80"} ${
        body().length > 0
          ? "hover:opacity-100 focus-within:opacity-100 has-[>details[open]]:opacity-100"
          : ""
      }`}
    >
      <Show when={body().length === 0}>
        <Spine class={spine()} />
      </Show>

      <Show
        when={body().length > 0}
        fallback={
          <div class="relative min-w-0 flow-root pl-2ch">
            <Marker class={caret()} />
            {head()}
          </div>
        }
      >
        <Collapsible summary={head()} caret={caret()} spine={spine()}>
          <div class={dimmed() ? "opacity-60" : ""}>
            <Body blocks={body()} />
          </div>
        </Collapsible>
      </Show>

      <Show when={summary().delivered.length > 0}>
        <div class="mt-1 pl-2ch">
          <Body blocks={summary().delivered} />
        </div>
      </Show>
    </article>
  );
}

/** One `apply_patch` call as peer rows, one per file, so paths stay visible collapsed. */
export function ToolCards(props: {
  readonly view: ToolView;
  readonly name?: string;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  // Unkeyed: a keyed list rebuilds the card on every delta and shuts an open row.
  return (
    <For each={splitPatchView(props.name, props.view)} keyed={false}>
      {(view) => <ToolCard {...props} view={view()} />}
    </For>
  );
}

/**
 * A row's name and the muted colon before its subject, floated so wrapped
 * lines keep the row's own left edge.
 */
export function RowLabel(props: {
  readonly label: string;
  readonly tone?: Tone;
}) {
  return (
    <Show when={props.label}>
      <span class="float-left">
        <span class={`font-bold ${toneClass(props.tone)}`}>{props.label}</span>
        <span class="pr-1ch text-neutral-400">:</span>
      </span>
    </Show>
  );
}

function splitPatchView(
  name: string | undefined,
  view: ToolView
): readonly ToolView[] {
  if (name !== "apply_patch") {
    return [view];
  }

  const body = view.body ?? [];
  const firstSection = body.findIndex((block) => block.kind === "section");
  if (firstSection === -1) {
    return [view];
  }

  const views: ToolView[] = [{ ...view, body: body.slice(0, firstSection) }];
  let rowBody: ViewBlock[] = [];
  for (const block of body.slice(firstSection)) {
    if (block.kind !== "section") {
      rowBody.push(block);
      continue;
    }
    rowBody = [];
    views.push({
      label: block.label,
      icon: block.icon,
      title: block.content,
      body: rowBody,
    });
  }
  return views;
}

function isDrawn(block: ViewBlock): boolean {
  return block.kind === "text" || block.kind === "notice"
    ? block.text.trim() !== ""
    : true;
}

function Head(props: {
  readonly view: ToolView;
  readonly name?: string;
  readonly tone?: Tone;
}) {
  const label = () => props.view.label ?? props.name ?? "";
  const subject = () => props.view.title.slice(0, 1);
  const details = () => props.view.title.slice(1);
  const prose = () => {
    const only =
      props.view.title.length === 1 ? props.view.title[0] : undefined;
    return only?.kind === "markdown" ? only.text : undefined;
  };

  return (
    <>
      <RowLabel label={label()} tone={props.tone} />
      <Show
        when={prose()}
        fallback={
          <span class="break-words [&_p]:inline">
            <Blocks blocks={subject()} />
            <For each={details()}>{(block) => <Detail block={block} />}</For>
          </span>
        }
      >
        {(text) => <Markdown text={text()} />}
      </Show>
    </>
  );
}

function Detail(props: { readonly block: ViewBlock }) {
  const bracketed = () => props.block.kind !== "spans";
  return (
    <span class="text-neutral-400">
      {" "}
      <Show when={bracketed()}>{"("}</Show>
      <Blocks blocks={[props.block]} />
      <Show when={bracketed()}>{")"}</Show>
    </span>
  );
}
