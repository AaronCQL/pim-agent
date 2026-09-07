import { createMemo, For, Show } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Caret, Collapsible } from "../ui/Collapsible";
import { Blocks, Body } from "./Blocks";
import { toneClass } from "./tokens";

/**
 * One tool row. The mockup supplies the shape; the TUI supplies the semantics,
 * and this is where the two meet:
 *
 * - There is **no glyph**. The caret is the only icon a row draws, and it also
 *   carries state the way the TUI's `▪` marker does — dim while partial, rose
 *   on error — so `view.icon` goes unpainted on the web.
 * - `label` is what the row is called (`ToolRow.name` only when the view omits
 *   it), then a muted `":"` and the `title` blocks as one run of text that
 *   wraps under itself rather than being cut off: a shell pipeline or a long
 *   pattern is the row's subject, and a phone is narrow. A lone `markdown`
 *   title goes through `Markdown`, as it does in
 *   `Renderer.renderToolCallTitle`. The label reads at the body colour — it
 *   names the row, it is not a heading over it — and only `labelTone` moves
 *   it off that, which is how a subagent shows its run state.
 * - `summary` renders in every state — streaming, collapsed, expanded — so it
 *   sits outside the disclosure.
 * - `body` is expand-only, and **every** row starts closed — a failure and a
 *   diff included, exactly as in the TUI. A transcript you scroll on a phone
 *   is a list of what happened; what a row
 *   did is the one line, and the payload is what you ask for. A call that is
 *   still running gets the same affordance as a settled one as soon as it has
 *   anything in it: output that only becomes readable once the tool returns is
 *   output you cannot watch. Blank blocks do not count — an argument-only view
 *   would otherwise open onto nothing. A call with nothing in it yet still
 *   draws the caret, in amber, so the row keeps its shape and its text keeps
 *   its column while it waits — but nothing brightens it and nothing points
 *   at it, because there is nothing behind it to reach. A failed call draws
 *   the same bodiless caret in rose: a call that did not happen must never
 *   render identically to one that did, whatever its view left out.
 * - An opened error shows its output whole and untruncated: a failure is read
 *   to be acted on, and the tail of a stack trace is not an aside.
 */
export function ToolCard(props: {
  readonly view: ToolView;
  /** Fallback label; the wire's tool name, which the view usually overrides. */
  readonly name?: string;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  // Memoised: a partial call re-renders on every delta, and this is read by
  // both the class object and the disclosure on each of them.
  const body = createMemo(() => (props.view.body ?? []).filter(isDrawn));
  const error = () => props.isError === true;
  // Opened output is quoted material — it recedes behind the row that names
  // it. A diff is the exception, and not because of which tool produced it:
  // its meaning *is* its colour, so dimming a diff dims the one thing that
  // makes it readable. Asking the blocks rather than `name` keeps that true
  // for any tool that reports a change, `apply_patch` sections included.
  const dimmed = () => !body().some((block) => block.kind === "diff");

  return (
    // A row recedes until hovered; an open one is the thing you asked to look
    // at, so it stays at full strength — that is *this* disclosure's own
    // state, not whether the row has a payload to disclose. Hence the child
    // combinator, which keeps that true no matter what a body turns out to
    // contain: a descendant `details[open]` would otherwise hold a collapsed
    // row at full strength for something nobody can see yet.
    //
    // A row with no body brightens for nobody: hover that leads to nothing is
    // a promise the row cannot keep.
    <article
      class={`min-w-0 opacity-80 ${
        body().length > 0
          ? "hover:opacity-100 focus-within:opacity-100 has-[>details[open]]:opacity-100"
          : ""
      }`}
    >
      <Show
        when={body().length > 0}
        fallback={
          <span class="flex min-w-0 items-start">
            <Show when={props.isPartial === true || error()}>
              <Caret class={caretClass(props.isPartial === true, error())} />
            </Show>
            <Head view={props.view} name={props.name} />
          </span>
        }
      >
        <Collapsible
          summary={<Head view={props.view} name={props.name} />}
          caret={caretClass(props.isPartial === true, error())}
          spine={error() ? "bg-rose-400" : "bg-neutral-750"}
        >
          <div class={dimmed() ? "opacity-60" : ""}>
            <Body blocks={body()} />
          </div>
        </Collapsible>
      </Show>
      <Show when={(props.view.summary?.length ?? 0) > 0}>
        <div class="pl-2ch text-neutral-400">
          <Body blocks={props.view.summary ?? []} />
        </div>
      </Show>
    </article>
  );
}

/**
 * One patch call can change several files. Its shared view represents each
 * file after the first as a body section for terminal renderers; on the web,
 * make those sections peer rows so every path remains visible when collapsed.
 */
export function ToolCards(props: {
  readonly view: ToolView;
  readonly name?: string;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  // Unkeyed, so the rows are matched by position: the split is a fresh array
  // of fresh views on every delta of a call still streaming, and a keyed list
  // would rebuild the whole card — disclosure and all — once per update, which
  // shuts a row the reader opened to watch it.
  return (
    <For each={splitPatchView(props.name, props.view)} keyed={false}>
      {(view) => <ToolCard {...props} view={view()} />}
    </For>
  );
}

/** The tint of a call still in flight, matching the `warning` tone. */
const PENDING_CARET = "bg-amber-400";

/** Neutral, amber while the call is still in flight, rose once it has failed. */
function caretClass(isPartial: boolean, isError: boolean): string {
  if (isPartial) {
    return PENDING_CARET;
  }
  return isError ? "bg-rose-400" : "bg-neutral-300";
}

/** Splits the `apply_patch` renderer's leading item and trailing sections. */
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
  // Each section opens a row, and everything up to the next one is that row's
  // body — held by reference so the walk stays a single forward pass.
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

/** A block that would paint nothing: an empty body is not a disclosure. */
function isDrawn(block: ViewBlock): boolean {
  return block.kind === "text" || block.kind === "notice"
    ? block.text.trim() !== ""
    : true;
}

function Head(props: { readonly view: ToolView; readonly name?: string }) {
  const label = () => props.view.label ?? props.name ?? "";
  const subject = () => props.view.title.slice(0, 1);
  const details = () => props.view.title.slice(1);
  const prose = () => {
    const only =
      props.view.title.length === 1 ? props.view.title[0] : undefined;
    return only?.kind === "markdown" ? only.text : undefined;
  };

  return (
    // Top-aligned, not centred: a `spans` title keeps its newlines and wraps,
    // and `Bash:` naming a four-line pipeline belongs on the pipeline's first
    // line rather than floating halfway down it.
    <span class="flex min-w-0 grow items-start">
      <Show when={label()}>
        <span class={`shrink-0 font-bold ${toneClass(props.view.labelTone)}`}>
          {label()}
        </span>
        <span class="shrink-0 pr-1ch text-neutral-400">:</span>
      </Show>
      <Show
        when={prose()}
        fallback={
          // One run of text, not a row of columns: the first block is the
          // subject and anything after it is an aside that reads right behind
          // it and wraps with it — `Grep: /foo/ (2 files)`. `Blocks` paints
          // text as `<p>`, so the run inlines those to keep it one paragraph.
          <span class="min-w-0 break-words [&_p]:inline">
            <Blocks blocks={subject()} />
            <For each={details()}>{(block) => <Detail block={block} />}</For>
          </span>
        }
      >
        {(text) => (
          <span class="min-w-0">
            <Markdown text={text()} />
          </span>
        )}
      </Show>
    </span>
  );
}

/**
 * A trailing title block. Prose — `2 files`, `12.4 kB · markdown` — is a
 * remark about the subject, and brackets keep it from reading as more of the
 * subject's own words. Diff counters do not take them: `+12/-3` is already
 * punctuation and colour, and `Edit: file.ts (+12/-3)` only boxes in
 * something that was never going to be mistaken for a path.
 */
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
