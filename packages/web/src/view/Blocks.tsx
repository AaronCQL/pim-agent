import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component, type Element } from "solid-js";

import type { IntraLineRange, ToolDiffLine } from "#core/shared/DiffLines";
import { Languages } from "#core/shared/Languages";
import { DiffLayout } from "#core/view/DiffLayout";
import { Painting } from "#core/view/Painting";
import type { DiffHunk, Span, ViewBlock } from "#core/view/ViewBlock";
import { Markdown } from "../markdown/Markdown";
import { CopyButton } from "../ui/CopyButton";
import { Attachments } from "./Attachments";
import { Highlight, type Token } from "./highlight";
import {
  DIFF_EMPHASIS_CLASSES,
  DIFF_GUTTER_CLASSES,
  DIFF_ROW_CLASSES,
  FRAME_CLASSES,
  NOTICE_CLASSES,
  groupByFrame,
  syntaxClass,
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

/**
 * Spans are one line of text cut into tones, not a row of chips: producers
 * write whatever spacing they mean into the span text (`+1`, `/`, `-1`), the
 * same way the ANSI painter concatenates them. So they are laid out inline
 * with no gap, and `pre-wrap` keeps a heredoc's newlines and a separator's
 * padding spaces from being collapsed away at a span boundary.
 */
function SpansBlock(props: { readonly block: BlockOf<"spans"> }) {
  return (
    <p class="whitespace-pre-wrap break-words">
      <For each={props.block.spans}>{(span) => <SpanText span={span} />}</For>
    </p>
  );
}

function SpanText(props: { readonly span: Span }) {
  return (
    // `code` gets no styling of its own: the whole UI is monospace, so a shell
    // command in a tool title is already set in the face a pill would be
    // announcing, and it is the row's subject — which reads at the body
    // colour, like every other subject.
    <span
      class={{
        [toneClass(props.span.tone)]: true,
        "line-through": props.span.strike === true,
        "font-bold": props.span.strong === true,
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
  const lines = createMemo(() =>
    Highlight.tokenize(props.block.text, Languages.resolve(props.block.lang))
  );

  return (
    <div class="relative">
      <pre class="overflow-x-auto leading-[--line] text-neutral-200 [tab-size:3]">
        <span class="block text-neutral-500" aria-hidden="true">
          {`\`\`\`${props.block.lang}`}
        </span>
        <code data-lang={props.block.lang}>
          <For each={lines()}>
            {(line, index) => (
              <span class="block">
                <Show when={props.block.startLine !== undefined}>
                  <span class="mr-1ch select-none text-neutral-600">
                    {(props.block.startLine ?? 1) + index()}
                  </span>
                </Show>
                <For each={line}>
                  {(token) => (
                    <span class={syntaxClass(token.role)}>{token.text}</span>
                  )}
                </For>
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

/**
 * A diff, drawn the way the terminal draws one: a numbered gutter, a sign,
 * syntax-highlighted code under a wash of green or red, and `⋯` where hunks
 * skip over unchanged lines. No `@@` headers and no per-hunk disclosure — the
 * gutter says where you are, and a payload you had to open a second time to
 * read was never worth opening the first.
 *
 * `w-max` is what makes the washes right: the rows sit in a horizontally
 * scrolling frame, and a row only as wide as the frame would have its
 * background stop mid-line the moment anything scrolled past the edge. The
 * gutter is `select-none`, so copying a diff yields the code and nothing else,
 * and tabs are sized rather than expanded, so the emphasis ranges — which
 * count characters of the original line — still land on the right ones.
 */
function DiffBlock(props: { readonly block: BlockOf<"diff"> }) {
  const lang = createMemo(() => Languages.fromPath(props.block.path));
  const width = createMemo(() => DiffLayout.gutterWidth(props.block.hunks));

  return (
    <div class="w-max min-w-full leading-[--line] text-neutral-300 [tab-size:3]">
      <For each={props.block.hunks}>
        {(hunk, index) => (
          <>
            <Show when={index() > 0}>
              <div class={`whitespace-pre ${DIFF_GUTTER_CLASSES.context}`}>
                {`${" ".repeat(width() + 1)}   ⋯`}
              </div>
            </Show>
            <Hunk hunk={hunk} lang={lang()} width={width()} />
          </>
        )}
      </For>
    </div>
  );
}

function Hunk(props: {
  readonly hunk: DiffHunk;
  readonly lang: string | undefined;
  readonly width: number;
}) {
  // One tokenisation per side of the hunk, not one per line: see
  // `DiffLayout.mapSides`. Memoised because it re-runs whenever a grammar
  // finishes loading, and that is the only time it should.
  const tokens = createMemo(() =>
    DiffLayout.mapSides(props.hunk, (block) =>
      Highlight.tokenize(block, props.lang)
    )
  );

  return (
    <For each={props.hunk.lines}>
      {(line, index) => (
        <DiffRow
          line={line}
          tokens={tokens()[index()] ?? [{ text: line.text }]}
          width={props.width}
        />
      )}
    </For>
  );
}

function DiffRow(props: {
  readonly line: ToolDiffLine;
  readonly tokens: readonly Token[];
  readonly width: number;
}) {
  const kind = () => props.line.kind;
  const gutter = () =>
    ` ${String(DiffLayout.lineNumber(props.line) ?? "").padStart(props.width)} ${SIGNS[kind()]} `;

  return (
    <div class={`whitespace-pre ${DIFF_ROW_CLASSES[kind()]}`}>
      <span class={`select-none ${DIFF_GUTTER_CLASSES[kind()]}`}>
        {gutter()}
      </span>
      <For each={emphasize(props.tokens, props.line.emphasis)}>
        {(piece) => (
          <span
            class={`${syntaxClass(piece.role)} ${
              piece.emphasis ? DIFF_EMPHASIS_CLASSES[kind()] : ""
            }`}
          >
            {piece.text}
          </span>
        )}
      </For>
    </div>
  );
}

/** `−` is the terminal's minus sign, and it lines up with `+`. */
const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLine["kind"], string>;

type Piece = Token & { readonly emphasis?: boolean };

/**
 * Syntax tokens re-cut against the intra-line emphasis ranges — the words a
 * line actually changed, which the terminal paints in a stronger wash. The two
 * are independent cuts of the same characters, so a token straddling the edge
 * of a range has to be split at it; ranges count characters, tokens carry
 * them, and this walks both at once.
 */
function emphasize(
  tokens: readonly Token[],
  ranges: readonly IntraLineRange[] = []
): readonly Piece[] {
  if (ranges.length === 0) {
    return tokens;
  }

  const pieces: Piece[] = [];
  let at = 0;

  for (const token of tokens) {
    let cut = 0;
    for (const stop of cuts(ranges, at, at + token.text.length)) {
      const text = token.text.slice(cut, stop);
      if (text !== "") {
        pieces.push({
          text,
          role: token.role,
          emphasis: inRange(ranges, at + cut),
        });
      }
      cut = stop;
    }
    at += token.text.length;
  }

  return pieces;
}

/**
 * Where a token spanning `[from, to)` has to be cut, as offsets into the
 * token itself and always ending at its end, so one pass over these produces
 * every piece the token is made of.
 */
function cuts(
  ranges: readonly IntraLineRange[],
  from: number,
  to: number
): readonly number[] {
  const stops = new Set<number>([to - from]);
  for (const range of ranges) {
    for (const edge of [range.start, range.end]) {
      if (edge > from && edge < to) {
        stops.add(edge - from);
      }
    }
  }
  return Array.from(stops).sort((first, second) => first - second);
}

function inRange(ranges: readonly IntraLineRange[], at: number): boolean {
  return ranges.some((range) => at >= range.start && at < range.end);
}

function FileBlock(props: { readonly block: BlockOf<"file"> }) {
  return (
    // The path is the subject wherever it appears — a `Read` title, a line of
    // `Glob` output — so it takes the colour of what it sits in rather than
    // one of its own; what trails it is detail, and recedes.
    <span>
      {props.block.path}
      <Show when={props.block.range}>
        {(range) => (
          <span class="text-neutral-400">{Painting.formatRange(range())}</span>
        )}
      </Show>
      <Show when={props.block.truncated === true}>
        <span class="ml-1ch text-neutral-400">truncated</span>
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
      class="text-indigo-300 hover:text-indigo-400 underline underline-offset-2"
      href={props.block.href}
      target="_blank"
      rel="noreferrer"
    >
      {props.block.label === "" ? props.block.href : props.block.label}
    </a>
  );
}

export function Notice(props: {
  readonly severity: keyof typeof NOTICE_CLASSES;
  readonly text: string;
  readonly tag?: Element;
}) {
  return (
    <p
      class={`whitespace-pre-wrap ${NOTICE_CLASSES[props.severity]}`}
      role={props.severity === "error" ? "alert" : undefined}
    >
      {props.tag === undefined ? props.text : [props.tag, props.text]}
    </p>
  );
}

function NoticeBlock(props: { readonly block: BlockOf<"notice"> }) {
  return <Notice severity={props.block.severity} text={props.block.text} />;
}

/**
 * A file the agent sent. The one block that is not a description of what the
 * agent did but a thing handed to the reader, so it is drawn as the file
 * itself — the same tile an inbound attachment gets, at delivery size.
 */
function AttachmentBlock(props: { readonly block: BlockOf<"attachment"> }) {
  return (
    <Attachments
      variant="delivery"
      files={[
        {
          key: props.block.url,
          name: props.block.name,
          url: props.block.url,
          isImage: props.block.isImage,
        },
      ]}
    />
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
  attachment: AttachmentBlock,
  notice: NoticeBlock,
};
