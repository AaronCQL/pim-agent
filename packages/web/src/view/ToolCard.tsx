import { createMemo, createSignal, For, Show } from "solid-js";

import { Lines } from "#core/shared/Lines";
import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Collapsible } from "../ui/Collapsible";
import { Blocks, Body } from "./Blocks";
import { toneClass } from "./tokens";

/** `Tools.DEFAULT_PREVIEW_LINES`: what the TUI collapses an error body to. */
const ERROR_PREVIEW_LINES = 10;

/**
 * One tool row. The mockup supplies the shape; the TUI supplies the semantics,
 * and this is where the two meet:
 *
 * - There is **no glyph**. The caret is the only icon a row draws, and it also
 *   carries state the way the TUI's `▪` marker does — dim while partial, rose
 *   on error — so `view.icon` goes unpainted on the web.
 * - `label` is what the row is called (`ToolRow.name` only when the view omits
 *   it), tinted by `labelTone`, then a muted `":"` and the `title` blocks on
 *   one truncating line. A lone `markdown` title goes through `Markdown`, as
 *   it does in `Renderer.renderToolCallTitle`.
 * - `summary` renders in every state — streaming, collapsed, expanded — so it
 *   sits outside the disclosure.
 * - `body` is expand-only, and `collapsed: false` forces it open. A call that
 *   is still running gets the same affordance as a settled one as soon as it
 *   has anything in it: output that only becomes readable once the tool
 *   returns is output you cannot watch. Blank blocks do not count — an
 *   argument-only view would otherwise open onto nothing.
 * - An error bypasses the view the way the TUI does: the row opens by default
 *   and shows the same 10-line preview, with the same `… N more lines` line as
 *   the way through to the rest.
 */
export function ToolCard(props: {
  readonly view: ToolView;
  /** Fallback label; the wire's tool name, which the view usually overrides. */
  readonly name?: string;
  readonly isError?: boolean;
  readonly isPartial?: boolean;
}) {
  // Memoised: a partial call re-renders on every delta, and this is read by
  // the class object, the disclosure and `failure()` on each of them.
  const body = createMemo(() => (props.view.body ?? []).filter(isDrawn));
  const error = () => props.isError === true;
  const failure = createMemo(() => (error() ? errorText(body()) : undefined));

  return (
    // A row recedes until hovered; an open one is the thing you asked to look
    // at, so it stays at full strength — that is the disclosure's own state,
    // not whether the row has a payload to disclose.
    <article class="min-w-0 opacity-80 hover:opacity-100 focus-within:opacity-100 has-[details[open]]:opacity-100">
      <Show
        when={body().length > 0}
        fallback={<Head view={props.view} name={props.name} />}
      >
        <Collapsible
          summary={<Head view={props.view} name={props.name} />}
          open={error() || props.view.collapsed === false}
          caret={caretClass(props.isPartial === true, error())}
          rule={error() ? "border-rose-400" : "border-neutral-750"}
        >
          <div class="text-neutral-400">
            <Show when={failure()} fallback={<Body blocks={body()} />}>
              {(text) => <ErrorBody text={text()} />}
            </Show>
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

/** Neutral, dim while the call is still in flight, rose once it has failed. */
function caretClass(isPartial: boolean, isError: boolean): string {
  if (isPartial) {
    return "bg-neutral-500";
  }
  return isError ? "bg-rose-400" : "bg-neutral-300";
}

/** A block that would paint nothing: an empty body is not a disclosure. */
function isDrawn(block: ViewBlock): boolean {
  return block.kind === "text" || block.kind === "notice"
    ? block.text.trim() !== ""
    : true;
}

function Head(props: { readonly view: ToolView; readonly name?: string }) {
  const label = () => props.view.label ?? props.name ?? "";
  const prose = () => {
    const only =
      props.view.title.length === 1 ? props.view.title[0] : undefined;
    return only?.kind === "markdown" ? only.text : undefined;
  };

  return (
    <span class="flex min-w-0 grow items-center">
      <Show when={label()}>
        <span
          class={`shrink-0 font-bold ${toneClass(props.view.labelTone ?? "title")}`}
        >
          {label()}
        </span>
        <span class="shrink-0 pr-1ch text-neutral-400">:</span>
      </Show>
      <Show
        when={prose()}
        fallback={
          // The first block is the subject and truncates; anything after it is
          // a stat or a range, and keeps its width — the mockup's `arg` plus
          // `detail`.
          <For each={props.view.title}>
            {(block, index) => (
              <span
                class={
                  index() === 0
                    ? "min-w-0 truncate"
                    : "shrink-0 pl-1ch text-neutral-400"
                }
              >
                <Blocks blocks={[block]} />
              </span>
            )}
          </For>
        }
      >
        {(text) => (
          <span class="min-w-0 truncate">
            <Markdown text={text()} />
          </span>
        )}
      </Show>
    </span>
  );
}

/**
 * The TUI's overflow rule, imported rather than re-derived: `… N more lines`
 * is both the notice and the way to the rest of the text.
 */
function ErrorBody(props: { readonly text: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const preview = createMemo(() =>
    Lines.buildPreviewLines(props.text, ERROR_PREVIEW_LINES)
  );

  return (
    <>
      <p class="overflow-x-auto whitespace-pre">
        {expanded() ? props.text : preview().preview}
      </p>
      <Show when={!expanded() && preview().overflow > 0}>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-300"
          onClick={() => {
            setExpanded(true);
          }}
        >
          {`… ${preview().overflow} more lines`}
        </button>
      </Show>
    </>
  );
}

/**
 * The text an error body is made of, or undefined when it is made of anything
 * else. A failing tool answers with its stderr, so in practice this is every
 * error row; a view that puts a diff or a table in one keeps the ordinary
 * painter instead of being flattened into a string.
 */
function errorText(blocks: readonly ViewBlock[]): string | undefined {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "text" && block.kind !== "notice") {
      return undefined;
    }
    texts.push(block.text);
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}
