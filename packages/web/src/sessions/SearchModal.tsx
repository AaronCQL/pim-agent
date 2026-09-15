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
import type { SearchHitView } from "#protocol/ServerEvent";
import { baseName, relativeTime } from "../format";
import type { SessionSearch, SessionStore } from "../session/SessionStore";
import { FIELD } from "../ui/classes";
import { createComboboxNavigation } from "../ui/Combobox";
import { Marked } from "../ui/Marked";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";

/** What one row draws before the rest becomes a count: one chatty session must not eat the viewport. */
const SNIPPET_LIMIT = 2;

/** Shorter than this and a query is a keystroke rather than a question, so it never leaves the browser. */
const MIN_QUERY = 2;

const DEBOUNCE_MS = 100;

type Marks = {
  readonly text: string;
  readonly ranges: readonly SearchRange[];
};

/** One matched session, cut to what the row shows of it. */
type Row = {
  readonly hit: SearchHitView;
  readonly heading: Marks;
  readonly snippets: readonly SearchSnippet[];
  /** Matching messages this row does not draw. */
  readonly more: number;
};

/** What the list holds: a search that never happened, an unasked question, one in flight, one nothing answered, or the rows. */
type Phase = "failed" | "prompt" | "waiting" | "empty" | "hits";

function scopeOf(scanned: number): string {
  return `${scanned} session${scanned === 1 ? "" : "s"}, including archived`;
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
    <li class="space-y-1 px-2 py-6 text-center text-neutral-500">
      <p>Search every session — titles and what was said</p>
      <Show when={props.ready} fallback={<Waiting />}>
        <p>{scopeOf(props.scanned)}</p>
      </Show>
    </li>
  );
}

/**
 * A session with no title is one nobody named that opens with no message of
 * its own, so what it matched on is a truer name for it than any word made up
 * here; failing even that, the id, as the sidebar does.
 */
function headingOf(hit: SearchHitView, promoted?: SearchSnippet): Marks {
  if (hit.title !== undefined) {
    return { text: hit.title, ranges: hit.titleRanges };
  }
  return promoted === undefined
    ? { text: hit.sessionId.slice(0, 8), ranges: [] }
    : { text: promoted.text, ranges: promoted.ranges };
}

function rowOf(hit: SearchHitView): Row {
  const promoted = hit.title === undefined ? hit.snippets[0] : undefined;
  const snippets = hit.snippets
    .slice(promoted === undefined ? 0 : 1)
    .slice(0, SNIPPET_LIMIT);
  const drawn = snippets.length + (promoted === undefined ? 0 : 1);
  return {
    hit,
    heading: headingOf(hit, promoted),
    snippets,
    more: Math.max(0, hit.total - drawn),
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

  createEffect(
    () => ({ index: navigation.activeIndex(), open: props.open }),
    ({ index, open }) => {
      if (open) {
        list
          ?.querySelector(`[data-index="${index}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    }
  );

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Search Sessions"
      header={<div class="font-bold leading-[--line]">Search Sessions</div>}
    >
      <Show when={props.open}>
        <div class="flex items-center gap-2 border-b border-neutral-700 p-3">
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
            placeholder="Search every session"
            class={FIELD}
            onInput={(event: InputEvent) => {
              setInput((event.currentTarget as HTMLInputElement).value);
            }}
            onKeyDown={navigation.onKeyDown}
          />
        </div>

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
          class="min-h-0 flex-1 overflow-y-auto p-1 text-sm"
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
                      "rounded-lg px-1 py-1": true,
                      "bg-neutral-800": index() === navigation.activeIndex(),
                    }}
                    onMouseEnter={() => {
                      navigation.setActiveIndex(index());
                    }}
                  >
                    <button
                      type="button"
                      class="flex w-full min-w-0 items-baseline gap-2 px-1 text-left"
                      onClick={() => {
                        attach(row.hit);
                      }}
                    >
                      <span class="min-w-0 flex-1 truncate text-neutral-100">
                        <Marked
                          text={row.heading.text}
                          ranges={row.heading.ranges}
                        />
                      </span>
                      <Show when={row.hit.archived}>
                        <span class="shrink-0 rounded-full bg-neutral-850 px-2 text-xs text-neutral-400">
                          archived
                        </span>
                      </Show>
                      <span class="shrink-0 text-xs text-neutral-500">
                        {baseName(row.hit.cwd)}
                      </span>
                      <span class="shrink-0 text-xs text-neutral-500">
                        {relativeTime(row.hit.settledAt)}
                      </span>
                    </button>

                    <For each={row.snippets}>
                      {(snippet) => (
                        <button
                          type="button"
                          class="flex w-full min-w-0 items-baseline gap-2 rounded-lg px-1 text-left text-neutral-400 hover:text-neutral-100"
                          onClick={() => {
                            attach(row.hit);
                          }}
                        >
                          <span class="w-8 shrink-0 text-neutral-500">
                            {snippet.role === "user" ? "you" : "pim"}
                          </span>
                          <span class="min-w-0 flex-1 truncate">
                            <Marked
                              text={snippet.text}
                              ranges={snippet.ranges}
                            />
                          </span>
                        </button>
                      )}
                    </For>

                    <Show when={row.more > 0}>
                      <p class="pl-10 text-xs text-neutral-500">
                        {`+${row.more} more matches`}
                      </p>
                    </Show>
                  </li>
                )}
              </For>
            </Match>
          </Switch>
        </ul>

        <Show when={rows().length > 0}>
          <div class="flex shrink-0 items-center border-t border-neutral-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm text-neutral-400">
            {`${rows().length} session${rows().length === 1 ? "" : "s"} · searched all ${scopeOf(scanned())}`}
          </div>
        </Show>
      </Show>
    </Modal>
  );
}
