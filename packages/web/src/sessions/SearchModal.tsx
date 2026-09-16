import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";

import type { SearchRange, SearchSnippet } from "#core/session/SearchIndex";
import { Format } from "#core/shared/Format";
import type { SearchHitView, SessionSearch } from "#protocol/ServerEvent";
import { baseName, relativeTime } from "../format";
import type { SessionStore } from "../session/SessionStore";
import { FIELD_BARE, FIELD_BOX, ROW_ACTIVE } from "../ui/classes";
import { createComboboxNavigation } from "../ui/Combobox";
import { Marked } from "../ui/Marked";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Modal } from "../ui/Modal";
import { followActive } from "../ui/scroll";
import { Spinner } from "../ui/Spinner";

/** Shorter than this and a query is a keystroke rather than a question, so it never leaves the browser. */
const MIN_QUERY = 2;

const DEBOUNCE_MS = 100;

/**
 * A line drawn from a window onto something longer, with the server's marks on
 * it. Only the head says whether it was cut: `text-overflow` can ellipsise the
 * end of a line and not the start, so the tail is the box's to cut and the
 * head is the server's.
 */
type Marks = {
  readonly text: string;
  readonly ranges: readonly SearchRange[];
  readonly cutHead?: true;
};

/** One matched session, cut to what the row shows of it. */
type Row = {
  readonly hit: SearchHitView;
  readonly heading: Marks;
  /** The one line under the heading: the best matching message, or the opening ask when the name is all that matched. */
  readonly said?: Marks;
};

/** What the list holds: a search that never happened, an unasked question, one in flight, one nothing answered, or the rows. */
type Phase = "failed" | "prompt" | "waiting" | "empty" | "hits";

function scopeOf(scanned: number): string {
  return `${Format.count(scanned, "session")}, including archived`;
}

/** The index building, or a query in flight: the same ring either way. */
function Waiting() {
  return (
    <p class="flex justify-center">
      <Spinner />
    </p>
  );
}

/** Nothing to list yet: the promise the feature rests on, and the count that lets a reader check it. */
function Prompt(props: { readonly ready: boolean; readonly scanned: number }) {
  return (
    <li class="space-y-1 px-2 py-6 text-center text-neutral-400">
      <p>Search session titles and content</p>
      <Show when={props.ready} fallback={<Waiting />}>
        <p>{scopeOf(props.scanned)}</p>
      </Show>
    </li>
  );
}

/** A windowed line, with the ellipsis for the run-up the window left behind. */
function Excerpt(props: { readonly marks: Marks }) {
  return (
    <>
      <Show when={props.marks.cutHead}>…</Show>
      <Marked text={props.marks.text} ranges={props.marks.ranges} />
    </>
  );
}

function marksOf(snippet: SearchSnippet): Marks {
  return {
    text: snippet.text,
    ranges: snippet.ranges,
    ...(snippet.cutHead === true ? { cutHead: true as const } : {}),
  };
}

/**
 * What stands between two facts on the meta line. Two stops below the facts it
 * parts, because a separator painted as brightly as its operands stops parting
 * them and becomes a third fact.
 */
function Dot() {
  return (
    <span class="shrink-0 text-neutral-600" aria-hidden="true">
      ·
    </span>
  );
}

/**
 * A session with no title is one nobody named that opens with no message of
 * its own, so what it matched on is a truer name for it than any word made up
 * here; failing even that, the id, as the sidebar does.
 *
 * The line beneath it is the best matching message the heading is not already
 * saying — an unnamed session is named by its opening ask, and a window onto
 * that same ask under it would be the row saying one thing twice — falling
 * back to the opening ask itself for a row the name alone matched.
 */
function rowOf(hit: SearchHitView): Row {
  const promoted = hit.title === undefined ? hit.snippets[0] : undefined;
  const heading =
    hit.title !== undefined
      ? { text: hit.title, ranges: hit.titleRanges }
      : promoted === undefined
        ? { text: hit.sessionId.slice(0, 8), ranges: [] }
        : marksOf(promoted);
  const snippet = hit.snippets.find(
    (candidate) => !heading.text.includes(candidate.text)
  );
  const said =
    snippet !== undefined
      ? marksOf(snippet)
      : hit.opening === undefined
        ? undefined
        : { text: hit.opening, ranges: [] };
  return {
    hit,
    heading,
    ...(said === undefined ? {} : { said }),
  };
}

/** Ranked search over every session on disk — the only honest one, because a page of the sidebar is a fraction of the tree. */
export function SearchModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
  /** Fires when a hit is opened, for whatever has to get out of the way. */
  readonly onNavigate?: () => void;
  readonly debounceMs?: number;
}) {
  const typing = createMediaQuery(KEYBOARD);
  const [input, setInput] = createSignal("");
  const [answer, setAnswer] = createSignal<{
    readonly asked: string;
    readonly found: SessionSearch;
  }>();
  const [scanned, setScanned] = createSignal(0);
  const [ready, setReady] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  let box: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  onCleanup(() => {
    clearTimeout(timer);
  });

  const asked = createMemo((): string => input().trim());

  const took = (found: SessionSearch): void => {
    setScanned(found.scanned);
    setReady(true);
    setFailure("");
  };

  const refused = (error: Error): void => {
    setFailure(error.message);
  };

  createEffect(
    () => ({ open: props.open, store: props.store }),
    ({ open, store }) => {
      if (!open) {
        return;
      }
      setInput("");
      setFailure("");
      if (untrack(typing) && box) {
        box.focus();
      }
      // The empty query is the warm call: it builds the index while the first
      // keystrokes are still being typed, and counts what the modal promises.
      void store.searchSessions("").then(took, refused);
    }
  );

  createEffect(
    () => ({
      open: props.open,
      query: asked(),
      store: props.store,
      wait: props.debounceMs ?? DEBOUNCE_MS,
    }),
    ({ open, query, store, wait }) => {
      const mine = ++generation;
      clearTimeout(timer);
      if (!open || query.length < MIN_QUERY) {
        setAnswer(undefined);
        return;
      }
      timer = setTimeout(() => {
        void store.searchSessions(query).then(
          (found) => {
            if (mine !== generation) {
              return;
            }
            setAnswer({ asked: query, found });
            took(found);
          },
          (error: Error) => {
            if (mine !== generation) {
              return;
            }
            setAnswer(undefined);
            refused(error);
          }
        );
      }, wait);
    }
  );

  const found = (): SessionSearch | undefined => {
    const held = answer();
    return held?.asked === asked() ? held.found : undefined;
  };

  const rows = createMemo((): readonly Row[] =>
    (found()?.hits ?? []).map(rowOf)
  );

  const phase = createMemo((): Phase => {
    // A search that did not happen owns the whole body: every other state
    // here names a scope, and there is none to name.
    if (failure() !== "") {
      return "failed";
    }
    if (asked().length < MIN_QUERY) {
      return "prompt";
    }
    if (found() === undefined) {
      return "waiting";
    }
    return rows().length > 0 ? "hits" : "empty";
  });

  const lost = (): readonly string[] => found()?.dropped ?? [];

  const kept = (): string =>
    asked()
      .split(/\s+/)
      .filter((word) => !lost().includes(word.toLowerCase()))
      .join(" ");

  const attach = (hit: SearchHitView): void => {
    props.onClose();
    props.onNavigate?.();
    void props.store.switchTo(hit.sessionId).catch(() => undefined);
  };

  const navigation = createComboboxNavigation({
    count: () => rows().length,
    open: () => props.open,
    onSelect: (index) => {
      const row = rows()[index];
      if (row) {
        attach(row.hit);
      }
    },
    onDismiss: props.onClose,
  });

  followActive(
    () => list,
    navigation.activeIndex,
    () => props.open
  );

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Search Sessions"
      size="column"
      header={
        <div class={FIELD_BOX}>
          <span
            class="i-griddy-icons:search size-4 shrink-0 text-neutral-500"
            aria-hidden="true"
          />
          <input
            ref={(element: HTMLInputElement) => {
              box = element;
            }}
            type="text"
            value={input()}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label="Search query"
            placeholder="Enter search term"
            class={FIELD_BARE}
            onInput={(event: InputEvent) => {
              setInput((event.currentTarget as HTMLInputElement).value);
            }}
            onKeyDown={navigation.onKeyDown}
          />
        </div>
      }
    >
      <Show when={props.open}>
        <Show when={lost().length > 0}>
          <p class="shrink-0 border-b border-neutral-750 px-3 py-2 text-xs text-neutral-400">
            {`searched for `}
            <span class="text-neutral-100">{kept()}</span>
            {` — no results for `}
            <span class="italic">{lost().join(", ")}</span>
          </p>
        </Show>

        <ul
          ref={(element: HTMLUListElement) => {
            list = element;
          }}
          role="listbox"
          class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 pr-[calc(0.5rem-var(--scrollbar))] text-sm"
        >
          <Switch>
            <Match when={phase() === "failed"}>
              <li class="px-2 py-1 text-neutral-500">
                {`The search failed — ${failure()}`}
              </li>
            </Match>
            <Match when={phase() === "prompt"}>
              <Prompt ready={ready()} scanned={scanned()} />
            </Match>
            <Match when={phase() === "waiting"}>
              <li class="px-2 py-6">
                <Waiting />
              </li>
            </Match>
            <Match when={phase() === "empty"}>
              <li class="px-2 py-1 text-neutral-500">
                {`No matches in ${scopeOf(scanned())}.`}
              </li>
            </Match>
            <Match when={phase() === "hits"}>
              <For each={rows()}>
                {(row, index) => (
                  <li
                    data-index={index()}
                    role="option"
                    aria-selected={
                      index() === navigation.activeIndex() ? "true" : "false"
                    }
                    class={{
                      "rounded-lg": true,
                      [ROW_ACTIVE]: index() === navigation.activeIndex(),
                    }}
                    onMouseMove={() => {
                      navigation.setActiveIndex(index());
                    }}
                  >
                    <button
                      type="button"
                      class="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left"
                      onClick={() => {
                        attach(row.hit);
                      }}
                    >
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="flex h-[--line] min-w-0 items-center gap-[1ch] text-sm text-neutral-400">
                          <span class="truncate text-neutral-350">
                            {baseName(row.hit.cwd)}
                          </span>
                          <Show when={row.hit.archived}>
                            <span
                              class="i-griddy-icons:archive size-3.5 shrink-0 text-neutral-500"
                              role="img"
                              aria-label="Archived"
                            />
                          </Show>
                          <Dot />
                          <span class="shrink-0">
                            {relativeTime(row.hit.settledAt)}
                          </span>
                          <Show when={row.hit.total > 1}>
                            <Dot />
                            <span class="shrink-0">
                              {`${row.hit.total} matches`}
                            </span>
                          </Show>
                        </span>
                        <span class="h-[--line] truncate font-semibold leading-[--line] text-neutral-100">
                          <Excerpt marks={row.heading} />
                        </span>
                        <span class="flex h-[--line] min-w-0 items-center gap-2 text-neutral-400">
                          <Show when={row.said}>
                            {(said) => (
                              <>
                                <span
                                  class="i-griddy-icons:arrow-elbow-down-right size-3.5 shrink-0 text-neutral-600"
                                  aria-hidden="true"
                                />
                                <span class="truncate">
                                  <Excerpt marks={said()} />
                                </span>
                              </>
                            )}
                          </Show>
                        </span>
                      </span>
                      <span
                        class={{
                          "i-griddy-icons:chevron-right size-4 shrink-0": true,
                          // The glyph never swaps: only its brightness says
                          // which row is picked, so the eye stays on the text.
                          "text-neutral-300":
                            index() === navigation.activeIndex(),
                          "text-neutral-500":
                            index() !== navigation.activeIndex(),
                        }}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                )}
              </For>
            </Match>
          </Switch>
        </ul>

        <Show when={phase() === "hits"}>
          <div class="flex shrink-0 items-center gap-4 border-t border-neutral-700 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-neutral-500">
            <Show when={typing()}>
              <Legend
                icons={["i-griddy-icons:arrow-elbow-down-left"]}
                verb="Open"
              />
              <Legend
                icons={["i-griddy-icons:arrow-up", "i-griddy-icons:arrow-down"]}
                verb="Move"
              />
              <span class="flex items-center gap-1.5">
                <kbd class="rounded bg-neutral-850 px-1">Esc</kbd>
                Close
              </span>
            </Show>
            <span class="ml-auto truncate">
              {`${rows().length} of ${scanned()} sessions`}
            </span>
          </div>
        </Show>
      </Show>
    </Modal>
  );
}

/** One key, or one pair of them, and what it does to the list. */
function Legend(props: {
  readonly icons: readonly string[];
  readonly verb: string;
}) {
  return (
    <span class="flex items-center gap-1.5">
      <span class="flex items-center gap-1">
        <For each={props.icons}>
          {(icon) => (
            <kbd class="flex size-4 items-center justify-center rounded bg-neutral-850">
              <span class={`${icon} size-3`} aria-hidden="true" />
            </kbd>
          )}
        </For>
      </span>
      {props.verb}
    </span>
  );
}
