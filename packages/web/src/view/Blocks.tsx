import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component, type Element } from "solid-js";

import { Painting } from "#core/view/Painting";
import type { DiffHunk, Span, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { Collapsible } from "../ui/Collapsible";
import { CopyButton } from "../ui/CopyButton";
import {
  DIFF_LINE_CLASSES,
  FRAME_CLASSES,
  NOTICE_CLASSES,
  TONE_CLASSES,
  groupByFrame,
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
    <p class="flex flex-wrap items-baseline gap-x-1ch">
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
        "font-bold": props.span.strong === true,
        // The whole UI is monospace, so code needs no face of its own; it is
        // set back from prose instead, the way a shell command in a tool title
        // is the argument and not the sentence. A pill would put the row off
        // the line grid by its own padding.
        [TONE_CLASSES.muted]:
          props.span.code === true && props.span.tone === undefined,
      }}
    >
      {props.span.text}
    </span>
  );
}

function SectionBlock(props: { readonly block: BlockOf<"section"> }) {
  return (
    <section>
      <h4 class="font-bold text-neutral-50">{props.block.label}</h4>
      <Body blocks={props.block.content} />
    </section>
  );
}

/**
 * A fenced block, fence included: the mockup draws the ` ``` `+lang as dim
 * text above and below the code rather than implying it with a card, so the
 * payload reads exactly as it would in the terminal that produced it.
 */
function CodeBlock(props: { readonly block: BlockOf<"code"> }) {
  return (
    <div class="relative">
      <pre class="overflow-x-auto leading-[--line] text-neutral-200">
        <span class="block text-neutral-500" aria-hidden="true">
          {`\`\`\`${props.block.lang}`}
        </span>
        <code data-lang={props.block.lang}>
          <For each={props.block.text.split("\n")}>
            {(line, index) => (
              <span class="block">
                <Show when={props.block.startLine !== undefined}>
                  <span class="mr-1ch select-none text-neutral-600">
                    {(props.block.startLine ?? 1) + index()}
                  </span>
                </Show>
                {line}
              </span>
            )}
          </For>
        </code>
        <span class="block text-neutral-500" aria-hidden="true">
          {"```"}
        </span>
      </pre>
      <CopyButton
        text={() => props.block.text}
        label="Copy code"
        class="absolute right-0 top-0"
      />
    </div>
  );
}

function DiffBlock(props: { readonly block: BlockOf<"diff"> }) {
  return (
    <div class="relative leading-[--line]">
      <CopyButton
        text={() => patchText(props.block.hunks)}
        label="Copy patch"
        class="absolute right-0 top-0"
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
      caret="bg-neutral-500"
      summary={
        <span class="flex items-baseline gap-1ch text-neutral-500">
          <span>{hunkRange(props.hunk)}</span>
          <span class="text-emerald-400">{`+${stat().added}`}</span>
          <span class="text-rose-400">{`-${stat().removed}`}</span>
        </span>
      }
    >
      <For each={props.hunk.lines}>
        {(line) => (
          <div class={`whitespace-pre ${DIFF_LINE_CLASSES[line.kind]}`}>
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
    <span class="text-neutral-300">
      {props.block.path}
      <Show when={props.block.range}>
        {(range) => (
          <span class="text-neutral-500">{Painting.formatRange(range())}</span>
        )}
      </Show>
      <Show when={props.block.truncated === true}>
        <span class="ml-1ch text-neutral-500">(truncated)</span>
      </Show>
    </span>
  );
}

/**
 * The mockup's hanging indent rather than a browser list: the marker is dim,
 * sits in the negative text-indent, and wrapped lines align with the text.
 */
function ListBlock(props: { readonly block: BlockOf<"list"> }) {
  return (
    <Dynamic component={props.block.ordered === true ? "ol" : "ul"}>
      <For each={props.block.items}>
        {(item, index) => (
          <ListRow
            marker={props.block.ordered === true ? `${index() + 1}.` : "-"}
          >
            <Block block={item} />
          </ListRow>
        )}
      </For>
    </Dynamic>
  );
}

function ListRow(props: {
  readonly marker: string;
  readonly children: Element;
}) {
  return (
    <li
      class="pl-[--marker] [text-indent:calc(var(--marker)*-1)]"
      style={{ "--marker": `${props.marker.length + 1}ch` }}
    >
      <span class="text-neutral-400">{`${props.marker} `}</span>
      {props.children}
    </li>
  );
}

function KvBlock(props: { readonly block: BlockOf<"kv"> }) {
  return (
    <dl class="grid grid-cols-[auto_1fr] gap-x-1ch">
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
      class="text-indigo-300 underline underline-offset-2"
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
