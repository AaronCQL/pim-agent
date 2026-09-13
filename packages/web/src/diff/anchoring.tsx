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
import type { ChangeSummary } from "#protocol/Diff";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import type { AnchorState, DiffAnchors } from "../view/anchors";
import { CommentEditor, CommentSheet } from "./CommentEditor";
import type { CommentAnchor, Comments, CommentSide } from "./Comments";

/** One file's review: what its gutters offer, and what hangs off them. */
export type Anchoring = DiffAnchors & {
  /** The comments made against the file itself, which name no line of it. */
  readonly fileCards: () => Element;
  /** Anchors a comment to a file that has no lines to point at. */
  readonly pickFile: () => void;
  readonly sheet: () => Element;
};

/**
 * What a reader has picked out, which is plain UI state: a comment of it is
 * made by the first keystroke, and never by the click that selected it.
 */
type Picked = {
  readonly side?: CommentSide;
  /** Where the pointer went down, and the line it last reached. */
  readonly from?: number;
  readonly to?: number;
  readonly quote?: string;
  /** The comment the first keystroke made of it; absent until then. */
  readonly id?: string;
};

/** A comment against the file rather than any line of it. */
const FILE = "file";

const NO_LINES: readonly string[] = [];

function spotOf(side?: CommentSide, line?: number): string {
  return side === undefined || line === undefined ? FILE : `${side}:${line}`;
}

/** A selection runs from the line it started on to the one it reached, either way round. */
function spanOf(
  picked: Picked
): { readonly start: number; readonly end: number } | undefined {
  if (picked.from === undefined) {
    return undefined;
  }
  const reached = picked.to ?? picked.from;
  return {
    start: Math.min(picked.from, reached),
    end: Math.max(picked.from, reached),
  };
}

function numberOf(line: ToolDiffLine, side: CommentSide): number | undefined {
  return side === "old" ? line.oldLine : line.newLine;
}

export function createAnchoring(options: {
  readonly comments: Comments;
  readonly file: () => ChangeSummary;
  readonly hunks: () => readonly ToolDiffHunk[];
}): Anchoring {
  const comments = options.comments;
  const [picked, setPicked] = createSignal<Picked>();
  /** A press is still down, so the selection is still being drawn. */
  const [sweeping, setSweeping] = createSignal(false);
  /** A saved comment tapped where there is no pointer, which the sheet answers. */
  const [tapped, setTapped] = createSignal<string>();
  const keyboard = createMediaQuery(KEYBOARD);
  const path = createMemo(() => options.file().path);
  const pickedId = createMemo(() => picked()?.id);

  const lift = (): void => {
    setSweeping(false);
  };

  // A press is released wherever the reader lets go — over another gutter, off
  // the diff, outside the window — so the lift is heard on the window rather
  // than on the gutter that heard the press. Attached by the first press and
  // left in place: one pair of listeners for a file that is being commented
  // on, none for the files merely being read.
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

  // Where the live editor hangs, as a key rather than the selection itself: the
  // first keystroke fills in an id, and the box being typed into must not be
  // rebuilt under the typist. Nothing hangs anywhere while the pointer is still
  // down: a reader sweeping out a range is owed the lines, not a box over them.
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
    if (text !== "") {
      setPicked({ ...held, id: comments.create(anchorOf(held), text) });
    }
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
    const number = numberOf(line, side);
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
    const number = numberOf(line, side);
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

  const saved = (id: string): Element => (
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
          onRemove={() => {
            comments.remove(id);
          }}
        />
      )}
    </Show>
  );

  const pickedText = (): string => {
    const id = pickedId();
    return id === undefined ? "" : (comments.one(id)?.text ?? "");
  };

  const live = (): Element => (
    <CommentEditor
      path={path()}
      text={pickedText()}
      stale={false}
      focus={true}
      editable={true}
      onWrite={write}
      onClose={() => {
        setPicked(undefined);
      }}
      onRemove={() => {
        const id = untrack(pickedId);
        if (id !== undefined) {
          comments.remove(id);
        }
        setPicked(undefined);
      }}
    />
  );

  // The live editor is rendered from the selection and left out of the saved
  // list, so the comment its first keystroke makes does not replace the box.
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

  const quoted = (held: Picked): readonly string[] => {
    const side = held.side;
    const span = spanOf(held);
    if (side === undefined || span === undefined) {
      return held.quote === undefined ? NO_LINES : [held.quote];
    }
    return options
      .hunks()
      .flatMap((hunk) => hunk.lines)
      .filter((line) => {
        const number = numberOf(line, side);
        return (
          number !== undefined && number >= span.start && number <= span.end
        );
      })
      .map((line) => line.text);
  };

  const close = (): void => {
    setTapped(undefined);
    setPicked(undefined);
  };

  const sheetText = (): string => {
    const id = sheeted()?.id;
    return id === undefined ? "" : (comments.one(id)?.text ?? "");
  };

  const sheetQuote = (): readonly string[] => {
    const target = sheeted();
    if (target?.id !== undefined) {
      const quote = comments.one(target.id)?.quote;
      return quote === undefined ? NO_LINES : [quote];
    }
    return target?.held === undefined ? NO_LINES : quoted(target.held);
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
        text={sheetText()}
        quote={sheetQuote()}
        onCancel={close}
        onSave={commit}
      />
    ),
  };
}
