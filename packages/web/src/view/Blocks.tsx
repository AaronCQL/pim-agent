import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component } from "solid-js";

import { Painting } from "../../../core/src/view/Painting";
import type {
  DiffHunk,
  Span,
  ViewBlock,
} from "../../../core/src/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Collapsible } from "../ui/Collapsible";
import { CopyButton } from "../ui/CopyButton";
import {
  DIFF_LINE_CLASSES,
  FRAME_CLASSES,
  NOTICE_CLASSES,
  groupByFrame,
  iconClass,
  toneClass,
} from "./tokens";

type BlockOf<TKind extends ViewBlock["kind"]> = Extract<
  ViewBlock,
  { kind: TKind }
>;

type BlockPainter<TKind extends ViewBlock["kind"]> = Component<{
  readonly block: BlockOf<TKind>;
}>;

type PainterMap = {
  readonly [TKind in ViewBlock["kind"]]: BlockPainter<TKind>;
};

/**
 * The recursive dispatcher. `list` and `section` hold
 * `ViewBlock[]` of their own, so recursion is forced by the type rather than
 * chosen; a `Record<kind, Component>` rather than a `<Switch>` is what makes a
 * kind added to the union without a painter a compile error at `PainterMap`.
 */
export function Blocks(props: { readonly blocks: readonly ViewBlock[] }) {
  return <For each={props.blocks}>{(block) => <Block block={block} />}</For>;
}

function Block(props: { readonly block: ViewBlock }) {
  return (
    <Dynamic
      component={PAINTERS[props.block.kind] as Component<{ block: ViewBlock }>}
      block={props.block}
    />
  );
}

/** Blocks in a body, wrapped run by run in the container their frame asks for. */
export function Body(props: { readonly blocks: readonly ViewBlock[] }) {
  return (
    <For each={groupByFrame(props.blocks)}>
      {(group) => (
        <div class={FRAME_CLASSES[group.frame]}>
          <Blocks blocks={group.blocks} />
        </div>
      )}
    </For>
  );
}

function TextBlock(props: { readonly block: BlockOf<"text"> }) {
  return (
    <p class={`whitespace-pre-wrap ${toneClass(props.block.tone)}`}>
      {props.block.text}
    </p>
  );
}

function MarkdownBlock(props: { readonly block: BlockOf<"markdown"> }) {
  return <Markdown text={props.block.text} />;
}

function SpansBlock(props: { readonly block: BlockOf<"spans"> }) {
  return (
    <p class="flex flex-wrap items-baseline gap-x-1">
      <For each={props.block.spans}>{(span) => <SpanText span={span} />}</For>
    </p>
  );
}

function SpanText(props: { readonly span: Span }) {
  return (
    <span
      class={{
        [toneClass(props.span.tone)]: true,
        "line-through": props.span.strike === true,
        "font-semibold": props.span.strong === true,
        "font-mono rounded bg-neutral-800 px-1": props.span.code === true,
      }}
    >
      {props.span.text}
    </span>
  );
}

function SectionBlock(props: { readonly block: BlockOf<"section"> }) {
  return (
    <section>
      <h4 class="flex items-center gap-1.5 text-neutral-100 font-medium">
        <Show when={props.block.icon}>
          <span class={iconClass(props.block.icon)} aria-hidden="true" />
        </Show>
        {props.block.label}
      </h4>
      <Body blocks={props.block.content} />
    </section>
  );
}

function CodeBlock(props: { readonly block: BlockOf<"code"> }) {
  return (
    <pre class="group/code relative overflow-x-auto p-2 font-mono text-xs leading-snug">
      <CopyButton
        text={() => props.block.text}
        label="Copy code"
        class="absolute right-1 top-1 opacity-0 group-hover/code:opacity-100"
      />
      <code data-lang={props.block.lang}>
        <For each={props.block.text.split("\n")}>
          {(line, index) => (
            <span class="block">
              <Show when={props.block.startLine !== undefined}>
                <span class="mr-2 select-none text-neutral-600">
                  {(props.block.startLine ?? 1) + index()}
                </span>
              </Show>
              {line}
            </span>
          )}
        </For>
      </code>
    </pre>
  );
}

function DiffBlock(props: { readonly block: BlockOf<"diff"> }) {
  return (
    <div class="group/diff relative font-mono text-xs leading-snug">
      <CopyButton
        text={() => patchText(props.block.hunks)}
        label="Copy patch"
        class="absolute right-1 top-1 opacity-0 group-hover/diff:opacity-100"
      />
      <For each={props.block.hunks}>{(hunk) => <Hunk hunk={hunk} />}</For>
    </div>
  );
}

/**
 * One hunk, one disclosure. A rename touching thirty files arrives as one
 * `diff` block, and the reason to read it on a phone is usually one hunk of
 * it — so each is foldable on its own and opens by default.
 */
function Hunk(props: { readonly hunk: DiffHunk }) {
  const stat = createMemo(() => ({
    added: props.hunk.lines.filter((line) => line.kind === "added").length,
    removed: props.hunk.lines.filter((line) => line.kind === "removed").length,
  }));

  return (
    <Collapsible
      open
      summary={
        <span class="flex items-baseline gap-2 px-1 text-neutral-500">
          <span>{hunkRange(props.hunk)}</span>
          <span class="text-emerald-400">{`+${stat().added}`}</span>
          <span class="text-red-400">{`-${stat().removed}`}</span>
        </span>
      }
    >
      <For each={props.hunk.lines}>
        {(line) => (
          <div class={`whitespace-pre px-2 ${DIFF_LINE_CLASSES[line.kind]}`}>
            {`${DIFF_MARKERS[line.kind]}${line.text}`}
          </div>
        )}
      </For>
    </Collapsible>
  );
}

function hunkRange(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function patchText(hunks: readonly DiffHunk[]): string {
  return hunks
    .map((hunk) =>
      [
        hunkRange(hunk),
        ...hunk.lines.map((line) => `${DIFF_MARKERS[line.kind]}${line.text}`),
      ].join("\n")
    )
    .join("\n");
}

const DIFF_MARKERS = {
  context: " ",
  added: "+",
  removed: "-",
} as const;

function FileBlock(props: { readonly block: BlockOf<"file"> }) {
  return (
    <span class="font-mono text-neutral-300">
      {props.block.path}
      <Show when={props.block.range}>
        {(range) => (
          <span class="text-neutral-500">{Painting.formatRange(range())}</span>
        )}
      </Show>
      <Show when={props.block.truncated === true}>
        <span class="ml-1 text-neutral-500">(truncated)</span>
      </Show>
    </span>
  );
}

function ListBlock(props: { readonly block: BlockOf<"list"> }) {
  return (
    <Dynamic
      component={props.block.ordered === true ? "ol" : "ul"}
      class={`ml-4 ${props.block.ordered === true ? "list-decimal" : "list-disc"}`}
    >
      <For each={props.block.items}>
        {(item) => (
          <li>
            <Block block={item} />
          </li>
        )}
      </For>
    </Dynamic>
  );
}

function KvBlock(props: { readonly block: BlockOf<"kv"> }) {
  return (
    <dl class="grid grid-cols-[auto_1fr] gap-x-2">
      <For each={props.block.pairs}>
        {(pair) => (
          <>
            <dt class="text-neutral-500">{pair[0]}</dt>
            <dd class="min-w-0 truncate text-neutral-200">{pair[1]}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

function LinkBlock(props: { readonly block: BlockOf<"link"> }) {
  return (
    <a
      class="text-sky-400 underline underline-offset-2"
      href={props.block.href}
      target="_blank"
      rel="noreferrer"
    >
      {props.block.label === "" ? props.block.href : props.block.label}
    </a>
  );
}

function NoticeBlock(props: { readonly block: BlockOf<"notice"> }) {
  return (
    <p
      class={`whitespace-pre-wrap ${NOTICE_CLASSES[props.block.severity]}`}
      role={props.block.severity === "error" ? "alert" : undefined}
    >
      {props.block.text}
    </p>
  );
}

const PAINTERS: PainterMap = {
  text: TextBlock,
  markdown: MarkdownBlock,
  spans: SpansBlock,
  section: SectionBlock,
  code: CodeBlock,
  diff: DiffBlock,
  file: FileBlock,
  list: ListBlock,
  kv: KvBlock,
  link: LinkBlock,
  notice: NoticeBlock,
};
