import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type Element,
} from "solid-js";

import type { ToolDiffHunk, ToolDiffLine } from "#core/shared/DiffLines";
import { DiffLayout } from "#core/view/DiffLayout";
import type { ChangeSummary } from "#protocol/Diff";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import {
  lineNumberOf,
  type AnchorState,
  type DiffAnchors,
} from "../view/anchors";
import { CommentEditor, CommentSheet } from "./CommentEditor";
import type { CommentAnchor, Comments, CommentSide } from "./Comments";

export type Anchoring = DiffAnchors & {
  /** Comments on the file as a whole. */
  readonly fileCards: () => Element;
  /** Starts a file-level comment, for files with no lines to pick. */
  readonly pickFile: () => void;
  readonly sheet: () => Element;
};

/** The current selection; it becomes a comment only on the first keystroke. */
type Picked = {
  readonly side?: CommentSide;
  readonly from?: number;
  readonly to?: number;
  readonly quote?: string;
  /** Set once the first keystroke creates the comment. */
  readonly id?: string;
};

type Span = { readonly start: number; readonly end: number };

const FILE = "file";

const NO_LINES: readonly ToolDiffLine[] = [];

function spotOf(side?: CommentSide, line?: number): string {
  return side === undefined || line === undefined ? FILE : `${side}:${line}`;
}

function spanOf(picked: Picked): Span | undefined {
  if (picked.from === undefined) {
    return undefined;
  }
  const reached = picked.to ?? picked.from;
  return {
    start: Math.min(picked.from, reached),
    end: Math.max(picked.from, reached),
  };
}

export function createAnchoring(options: {
  readonly comments: Comments;
  readonly file: () => ChangeSummary;
  readonly hunks: () => readonly ToolDiffHunk[];
}): Anchoring {
  const comments = options.comments;
  const [picked, setPicked] = createSignal<Picked>();
  /** True while the pointer is down. */
  const [sweeping, setSweeping] = createSignal(false);
  /** A saved comment tapped on touch, shown in the sheet. */
  const [tapped, setTapped] = createSignal<string>();
  const keyboard = createMediaQuery(KEYBOARD);
  const path = createMemo(() => options.file().path);
  const pickedId = createMemo(() => picked()?.id);

  const lift = (): void => {
    setSweeping(false);
  };

  // The pointer may be released anywhere, so listen on the window.
  // Attached lazily on first press and kept until cleanup.
  let listening = false;
  const watch = (): void => {
    setSweeping(true);
    if (listening) {
      return;
    }
    listening = true;
    window.addEventListener("pointerup", lift);
    window.addEventListener("pointercancel", lift);
  };
  onCleanup(() => {
    window.removeEventListener("pointerup", lift);
    window.removeEventListener("pointercancel", lift);
  });

  // A key, not the selection, so setting the id on first keystroke doesn't rebuild the editor.
  // Hidden while the pointer is still down.
  const spot = createMemo(() => {
    const held = picked();
    if (held === undefined || sweeping() || !keyboard()) {
      return undefined;
    }
    return spotOf(held.side, spanOf(held)?.end);
  });

  const sheeted = createMemo<
    { readonly id?: string; readonly held?: Picked } | undefined
  >(() => {
    const id = tapped();
    if (id !== undefined) {
      return { id };
    }
    const held = picked();
    return held === undefined || sweeping() || keyboard()
      ? undefined
      : { held };
  });

  const anchorOf = (held: Picked): CommentAnchor =>
    untrack(() => ({
      path: options.file().path,
      fingerprint: options.file().fingerprint,
      side: held.side,
      quote: held.quote,
      ...spanOf(held),
    }));

  const write = (text: string): void => {
    const held = untrack(picked);
    if (held === undefined) {
      return;
    }
    if (held.id !== undefined) {
      comments.write(held.id, text);
      return;
    }
    if (text.trim() !== "") {
      setPicked({ ...held, id: comments.create(anchorOf(held), text) });
    }
  };

  // An emptied comment is deleted, but the selection and editor stay open.
  const forget = (): void => {
    const held = untrack(picked);
    if (held?.id === undefined) {
      return;
    }
    comments.remove(held.id);
    setPicked({ ...held, id: undefined });
  };

  const widen = (held: Picked, line: number): void => {
    setPicked({ ...held, to: line });
    if (held.id !== undefined) {
      comments.extend(held.id, line);
    }
  };

  const pick = (
    line: ToolDiffLine,
    side: CommentSide,
    extend: boolean
  ): void => {
    const number = lineNumberOf(line, side);
    if (number === undefined) {
      return;
    }
    const held = untrack(picked);
    if (extend && held?.side === side && held.from !== undefined) {
      widen(held, number);
      return;
    }
    setPicked({ side, from: number, to: number, quote: line.text });
  };

  const onPress = (
    line: ToolDiffLine,
    side: CommentSide,
    extend: boolean
  ): void => {
    watch();
    pick(line, side, extend);
  };

  const onSweep = (line: ToolDiffLine, side: CommentSide): void => {
    const held = untrack(picked);
    const number = lineNumberOf(line, side);
    if (
      held?.side === side &&
      held.from !== undefined &&
      number !== undefined &&
      number !== held.to
    ) {
      widen(held, number);
    }
  };

  const stateOf = (
    side: CommentSide,
    line: number | undefined
  ): AnchorState => {
    if (line === undefined) {
      return "idle";
    }
    const held = picked();
    const span = held?.side === side ? spanOf(held) : undefined;
    const inSpan = span !== undefined && line >= span.start && line <= span.end;
    return inSpan || comments.holds(path(), side, line) ? "held" : "idle";
  };

  const holdsCards = (side: CommentSide, line: number | undefined): boolean =>
    line !== undefined &&
    (comments.ids(path(), side, line).length > 0 ||
      spot() === spotOf(side, line));

  const saved = (id: string): Element => {
    const drop = (): void => {
      comments.remove(id);
    };
    return (
      <Show when={comments.one(id)}>
        {(held) => (
          <CommentEditor
            path={path()}
            text={held().text}
            stale={held().fingerprint !== options.file().fingerprint}
            editable={keyboard()}
            onWrite={(text) => {
              comments.write(id, text);
            }}
            onOpen={() => {
              setTapped(id);
            }}
            onDiscard={drop}
            onRemove={drop}
          />
        )}
      </Show>
    );
  };

  const textOf = (id: string | undefined): string =>
    id === undefined ? "" : (comments.one(id)?.text ?? "");

  const live = (): Element => (
    <CommentEditor
      path={path()}
      text={textOf(pickedId())}
      stale={false}
      focus={true}
      editable={true}
      onWrite={write}
      onClose={() => {
        setPicked(undefined);
      }}
      onDiscard={forget}
      onRemove={() => {
        const id = untrack(pickedId);
        if (id !== undefined) {
          comments.remove(id);
        }
        setPicked(undefined);
      }}
    />
  );

  // The live editor's own comment is excluded from the saved list so it isn't rendered twice.
  const stack = (key: string, ids: () => readonly string[]): Element => (
    <>
      <For each={ids().filter((id) => id !== pickedId())}>
        {(id) => saved(id)}
      </For>
      <Show when={spot() === key}>{live()}</Show>
    </>
  );

  const cardsAt = (side: CommentSide, line: number | undefined): Element =>
    line === undefined
      ? undefined
      : stack(spotOf(side, line), () => comments.ids(path(), side, line));

  /** The diff rows in `span`, falling back to the saved quote when they have moved. */
  const quoted = (
    side: CommentSide | undefined,
    span: Span | undefined,
    quote: string | undefined
  ): readonly ToolDiffLine[] => {
    const lines =
      side === undefined || span === undefined
        ? NO_LINES
        : options
            .hunks()
            .flatMap((hunk) => hunk.lines)
            .filter((line) => {
              const number = lineNumberOf(line, side);
              return (
                number !== undefined &&
                number >= span.start &&
                number <= span.end
              );
            });
    if (lines.length > 0) {
      return lines;
    }
    return quote === undefined ? NO_LINES : [{ kind: "context", text: quote }];
  };

  const close = (): void => {
    setTapped(undefined);
    setPicked(undefined);
  };

  const sheetQuote = (): readonly ToolDiffLine[] => {
    const target = sheeted();
    if (target?.id !== undefined) {
      const held = comments.one(target.id);
      const span =
        held?.start === undefined
          ? undefined
          : { start: held.start, end: held.end ?? held.start };
      return quoted(held?.side, span, held?.quote);
    }
    const held = target?.held;
    return held === undefined
      ? NO_LINES
      : quoted(held.side, spanOf(held), held.quote);
  };

  const commit = (text: string): void => {
    const target = untrack(sheeted);
    if (target?.id === undefined) {
      write(text);
    } else {
      comments.write(target.id, text);
    }
    close();
  };

  return {
    onPress,
    onPick: pick,
    onSweep,
    stateOf,
    holdsCards,
    cardsAt,
    fileCards: () => stack(FILE, () => comments.ids(path())),
    pickFile: () => {
      setPicked({});
    },
    sheet: () => (
      <CommentSheet
        open={sheeted() !== undefined}
        path={path()}
        text={textOf(sheeted()?.id)}
        quote={sheetQuote()}
        width={DiffLayout.gutterWidth(options.hunks())}
        onCancel={close}
        onSave={commit}
      />
    ),
  };
}
