import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
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

/** Shorter queries are never sent. */
const MIN_QUERY = 2;

const DEBOUNCE_MS = 100;

/** Highlighted text. Only a cut head is flagged; CSS truncates the tail. */
type Marks = {
  readonly text: string;
  readonly ranges: readonly SearchRange[];
  readonly cutHead?: true;
};

type Row = {
  readonly hit: SearchHitView;
  readonly heading: Marks;
  /** Best matching message not already in the heading, else the opening message. */
  readonly said?: Marks;
};

type Phase = "failed" | "prompt" | "waiting" | "empty" | "hits";

function scopeOf(scanned: number): string {
  return `${Format.count(scanned, "session")}, including archived`;
}

function Waiting() {
  return (
    <p class="flex justify-center">
      <Spinner />
    </p>
  );
}

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

function Dot() {
  return (
    <span class="shrink-0 text-neutral-600" aria-hidden="true">
      ·
    </span>
  );
}

/** Heading is the title, else the first snippet, else the short id. */
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

/** Server-side search over every session, not just the listed ones. */
export function SearchModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
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
      // Empty query warms the index and returns the session count.
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
      // The last failure belonged to the previous query.
      setFailure("");
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
            type="text"
            value={input()}
            autofocus={typing()}
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
                            {props.store.projectLabel(row.hit.cwd) ??
                              baseName(row.hit.cwd)}
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
