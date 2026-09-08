import { createMemo, For, Show } from "solid-js";

import type { Tone, ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Caret, Collapsible } from "../ui/Collapsible";
import { Blocks, Body } from "./Blocks";
import { caretClass, spineClass, toneClass } from "./tokens";

/**
 * One tool row. The mockup supplies the shape; the TUI supplies the semantics,
 * and this is where the two meet:
 *
 * - There is **no glyph**. The caret is the only icon a row draws, and it also
 *   carries state the way the TUI's `▪` marker does — dim while partial, rose
 *   on error — so `view.icon` goes unpainted on the web.
 * - `label` is what the row is called (`ToolRow.name` only when the view omits
 *   it), then a muted `":"` and the `title` blocks as one run of text that
 *   wraps to the row's own `2ch` gutter rather than being cut off or indented
 *   under the label: a shell pipeline or a long pattern is the row's subject,
 *   a phone is narrow, and `apply_patch: ` would otherwise spend a third of
 *   every continuation line naming what the first line already named. The
 *   label floats out of the run's way so the text flows past it, which is
 *   what makes that true of a `markdown` title too — it is a block, and a
 *   flex row would have stranded it. A lone `markdown` title goes through
 *   `Markdown`, as it does in `Renderer.renderToolCallTitle`. The label reads
 *   at the body colour — it names the row, it is not a heading over it —
 *   until the row has news: amber in flight and rose once it has failed, the
 *   caret's own hues, so the one word a reader is scanning for down the left
 *   edge carries the state rather than making them find a 1ch glyph beside
 *   it. The subject stays neutral throughout; it is what the row *did*, and
 *   it does not change because the row is still doing it. A view that sets
 *   `labelTone` outranks all of that, which is how a subagent paints its own
 *   run state.
 * - `summary` renders in every state — streaming, collapsed, expanded — so it
 *   rides in the `<summary>` alongside the head rather than in the payload,
 *   which is also the order `BodyRenderer` draws the two in.
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
  // it. Two kinds of block are not. A diff's meaning *is* its colour, so
  // dimming one dims the only thing that makes it readable; and markdown is
  // prose a model wrote to be read rather than a payload it dumped, which is
  // the whole of a subagent's answer. Asking the blocks rather than `name`
  // keeps both true for any tool that emits them, `apply_patch` sections
  // included.
  const dimmed = () =>
    !body().some((block) => block.kind === "diff" || block.kind === "markdown");

  // The same state the caret and the spine read, in the tones that map onto
  // their hues. A view that paints its own label has already said something
  // more specific than "running" — a subagent's indigo — so it wins.
  const tone = (): Tone | undefined =>
    props.view.labelTone ??
    (error() ? "error" : props.isPartial === true ? "warning" : undefined);

  // The whole visible face of the row: what it is called and what it is
  // doing. Both branches below draw it, and only one of them ever runs, so
  // this is a call rather than a shared node.
  const head = () => (
    <>
      <Head view={props.view} name={props.name} tone={tone()} />
      <Show when={(props.view.summary?.length ?? 0) > 0}>
        <div class="text-neutral-400">
          <Body blocks={props.view.summary ?? []} />
        </div>
      </Show>
    </>
  );

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
          // The same gutter a disclosure indents by, so a row with nothing to
          // open keeps the column its neighbours are in — with or without the
          // caret that only a partial or failed call earns. `flow-root` for
          // the same reason the disclosure's summary has it: the label floats.
          <div class="relative min-w-0 flow-root pl-2ch">
            <Show when={props.isPartial === true || error()}>
              <Caret class={caretClass(props.isPartial === true, error())} />
            </Show>
            {head()}
          </div>
        }
      >
        <Collapsible
          summary={head()}
          caret={caretClass(props.isPartial === true, error())}
          spine={spineClass(props.isPartial === true, error())}
        >
          <div class={dimmed() ? "opacity-60" : ""}>
            <Body blocks={body()} />
          </div>
        </Collapsible>
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

/**
 * What a row is called, and the muted colon that hands the rest of the line
 * to its subject. Shared rather than copied, because the subagent row is a
 * `<button>` that draws no disclosure and still has to sit on the same left
 * edge as the tool rows above and below it.
 *
 * It floats: the subject then starts after the label on the first line and
 * flows back to the row's own left edge on every line after it, which is what
 * the terminal's `│` gutter does and what a flex row cannot do. Floating the
 * pair as one box rather than each span keeps `Bash` and its colon from ever
 * being split across two lines.
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
    // One run of text with the label floated into it, so `Bash:` naming a
    // four-line pipeline sits on the pipeline's first line and the other
    // three keep the row's left edge.
    <>
      <RowLabel label={label()} tone={props.tone} />
      <Show
        when={prose()}
        fallback={
          // One run of text, not a row of columns: the first block is the
          // subject and anything after it is an aside that reads right behind
          // it and wraps with it — `Grep: /foo/ (2 files)`. `Blocks` paints
          // text as `<p>`, so the run inlines those to keep it one paragraph.
          <span class="break-words [&_p]:inline">
            <Blocks blocks={subject()} />
            <For each={details()}>{(block) => <Detail block={block} />}</For>
          </span>
        }
      >
        {/* No wrapper: `Markdown` is a block, and it is the float it has to
            flow around — a box of its own would be pushed clear of the label
            entirely and take the whole title with it. */}
        {(text) => <Markdown text={text()} />}
      </Show>
    </>
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
