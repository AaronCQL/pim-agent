import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";

import type { DirectoryListing } from "#core/shared/Directories";
import { abbreviateHome } from "../format";
import type { SessionStore } from "../session/SessionStore";
import { ACTION, FIELD, ICON } from "../ui/classes";
import { createComboboxNavigation } from "../ui/Combobox";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Modal } from "../ui/Modal";

/**
 * One place the reader could go: a directory they have worked in before, or
 * one inside the directory being browsed.
 */
type Row = {
  readonly path: string;
  readonly label: string;
  /**
   * A directory this machine already has sessions in. Those are destinations
   * rather than steps — a reader who picks one has arrived — so they open on
   * a click where a subdirectory would be stepped into.
   */
  readonly recent: boolean;
};

/**
 * Where to work, and the only control in the top bar that changes anything.
 *
 * **The list navigates; the footer commits.** A subdirectory is a step and
 * says so by moving the box above it; the button at the foot opens whatever
 * the box has arrived at, and always spells out where that is. The two
 * gestures are never the same one, so nothing here can open a session in a
 * directory the reader was only passing through — the exception being a
 * recent directory, which is a place they have already chosen once and which
 * is offered only while nothing is being completed.
 *
 * Picking a directory always opens a *new* session in it, because pi files a
 * session's log under the directory it was started in: a conversation cannot
 * move without leaving its own transcript behind. The reader is told that by
 * the button, which says what it does.
 */
export function DirectoryModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
}) {
  // Whether there is a keyboard to type a path with, which is the question
  // an autofocus is really asking.
  const typing = createMediaQuery(KEYBOARD);
  const [input, setInput] = createSignal("");
  /**
   * The last answer, and the path that was asked for. Kept as a pair because
   * the reader can be somewhere the server has not answered about yet, and a
   * listing shown under a box naming another directory is the modal lying
   * about where it is — and, worse, offering to open it.
   */
  const [answer, setAnswer] = createSignal<{
    readonly asked: string;
    readonly listing: DirectoryListing;
  }>();
  const [failure, setFailure] = createSignal("");
  const [recents, setRecents] = createSignal<readonly string[]>([]);
  // Only exists while the modal is open: its body is built on the way in.
  let box: HTMLInputElement | undefined;
  // Answers out of order are the norm here: a pasted path changes the
  // directory being read several times in one task.
  let generation = 0;

  const here = (): string => props.store.state.cwd;

  /**
   * Everything up to the last separator is a directory to read, everything
   * after it is a filter over what is in it — which is what makes typing and
   * clicking the same gesture. Only a rooted path is split that way: anything
   * else is a name typed bare, which searches where the reader already is
   * rather than resolving against whatever directory the server's own process
   * happens to have been started in.
   */
  const cut = (): number =>
    /^[/~]/.test(input()) ? input().lastIndexOf("/") : -1;
  const anchor = createMemo((): string => {
    const at = cut();
    return at < 0 ? here() : input().slice(0, at) || "/";
  });
  const filter = (): string => input().slice(cut() + 1);

  /** The directory being browsed, once the server has answered about it. */
  const listing = (): DirectoryListing | undefined => {
    const found = answer();
    return found?.asked === anchor() ? found.listing : undefined;
  };

  createEffect(
    () => props.open,
    (open) => {
      if (!open) {
        return;
      }
      // Opens on the current directory's contents rather than on an empty
      // box: the question is nearly always "somewhere near here", and a
      // reader who wants to type over it has the whole line selected.
      setInput(`${untrack(here)}/`);
      setFailure("");
      void props.store
        .recentDirectories()
        .then(setRecents)
        .catch(() => undefined);
      // A phone would answer an autofocus with the software keyboard over
      // the list, which is the half of this the reader came to look at.
      if (untrack(typing) && box) {
        box.focus();
        box.setSelectionRange(0, box.value.length);
      }
    }
  );

  createEffect(
    () => ({ open: props.open, path: anchor() }),
    ({ open, path }) => {
      // Bumped before the early return as well, so an answer still in flight
      // when the modal closes cannot seed the next open.
      const mine = ++generation;
      if (!open) {
        return;
      }
      void props.store.listDirectory(path).then(
        (found) => {
          if (mine === generation) {
            setAnswer({ asked: path, listing: found });
            setFailure("");
          }
        },
        (error: Error) => {
          if (mine === generation) {
            setAnswer(undefined);
            setFailure(error.message);
          }
        }
      );
    }
  );

  const rows = createMemo<readonly Row[]>(() => {
    const typed = filter().toLowerCase();
    const matches = (candidate: string): boolean =>
      candidate.toLowerCase().includes(typed);
    // A dot-directory is noise until it is asked for, and typing a dot is
    // how it is asked for.
    const dotted = typed.startsWith(".");
    return [
      // Only while nothing is being completed. A reader part-way through a
      // path is choosing between the directories in front of them, and a
      // recent one that happens to contain those letters somewhere would
      // outrank the completion under the cursor — and be what the footer
      // opened.
      ...(typed === ""
        ? recents().map((path) => ({
            path,
            label: abbreviateHome(path),
            recent: true,
          }))
        : []),
      ...(listing()?.entries ?? [])
        .filter(
          (entry) =>
            (dotted || !entry.name.startsWith(".")) && matches(entry.name)
        )
        .map((entry) => ({
          path: entry.path,
          label: entry.name,
          recent: false,
        })),
    ];
  });

  const navigation = createComboboxNavigation({
    count: () => rows().length,
    open: () => props.open,
    onSelect: (index) => {
      const row = rows()[index];
      if (row) {
        choose(row);
      }
    },
    onDismiss: props.onClose,
  });

  /**
   * What the footer would open. The directory being browsed while the box
   * names it exactly; the highlighted row while it does not, so a path typed
   * most of the way opens the completion the reader is looking at rather
   * than the directory above it.
   */
  const target = createMemo((): string | undefined =>
    filter() === "" ? listing()?.path : rows()[navigation.activeIndex()]?.path
  );

  /**
   * Somewhere to go — including the directory already open. A second session
   * in the same place is a normal thing to want, so the current directory is
   * a destination like any other rather than a disabled button.
   */
  const settled = (): boolean => target() !== undefined;

  const footer = (): string => {
    const path = target();
    return path === undefined ? "Nowhere to open" : abbreviateHome(path);
  };

  const commit = (path: string): void => {
    props.onClose();
    // A refused directory lands on `state.error`, which the shell paints;
    // there is nothing left here but an unhandled rejection.
    void props.store.openDirectory(path).catch(() => undefined);
  };

  const choose = (row: Row): void => {
    if (row.recent) {
      commit(row.path);
      return;
    }
    setInput(`${row.path}/`);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Taken before the list sees it: Enter alone belongs to the row under the
    // cursor, and the modifier is how a reader says "here, not in there".
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const path = target();
      if (path !== undefined) {
        commit(path);
      }
      return;
    }
    navigation.onKeyDown(event);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Choose Directory"
      // Nothing under the title: the box opens on the directory the session
      // is in and the footer names what the button will open, so a third
      // statement of it would be the only thing on screen said twice.
      header={<div class="font-bold leading-[--line]">Choose Directory</div>}
    >
      {/* Built on the way in and dropped on the way out: a closed dialog is
          hidden, not absent, so a body left mounted is a directory listing
          kept warm for a modal nobody is looking at. */}
      <Show when={props.open}>
        <div class="flex items-center gap-2 border-b border-neutral-700 p-3">
          <button
            type="button"
            aria-label="Parent directory"
            title="Parent directory"
            disabled={listing()?.parent === undefined}
            class={`${ICON} disabled:opacity-40`}
            onClick={() => {
              const parent = listing()?.parent;
              if (parent !== undefined) {
                setInput(`${parent}/`);
              }
            }}
          >
            <span class="i-griddy-icons:arrow-up size-4" aria-hidden="true" />
          </button>
          <input
            ref={(element: HTMLInputElement) => {
              box = element;
            }}
            type="text"
            value={input()}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label="Directory path"
            class={FIELD}
            onInput={(event: InputEvent) => {
              setInput((event.currentTarget as HTMLInputElement).value);
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        <ul role="listbox" class="min-h-0 flex-1 overflow-y-auto p-1 text-sm">
          <Show when={rows().length === 0}>
            <li class="px-2 py-1 text-neutral-500">
              {failure() || "Nothing to open in here."}
            </li>
          </Show>
          <For each={rows()}>
            {(row, index) => (
              <li
                role="option"
                aria-selected={
                  index() === navigation.activeIndex() ? "true" : "false"
                }
                class={{
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1": true,
                  "bg-neutral-800 text-neutral-50":
                    index() === navigation.activeIndex(),
                }}
                onMouseEnter={() => {
                  navigation.setActiveIndex(index());
                }}
                onClick={() => {
                  choose(row);
                }}
              >
                <span
                  class={`size-4 shrink-0 ${row.recent ? "i-griddy-icons:time-back" : "i-griddy-icons:folder"}`}
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate">{row.label}</span>
                <Show when={row.recent}>
                  <span class="ml-auto shrink-0 pl-2 text-xs text-neutral-500">
                    recent
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>

        {/* The one place that says what the button will do, because the box
            above may be half-typed and the row under the cursor may be a step
            rather than a destination. */}
        <div class="flex shrink-0 items-center gap-3 border-t border-neutral-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span class="min-w-0 flex-1 truncate text-sm text-neutral-400">
            {footer()}
          </span>
          <button
            type="button"
            disabled={!settled()}
            title="Start a new session in this directory"
            class={ACTION}
            onClick={() => {
              const path = target();
              if (path !== undefined) {
                commit(path);
              }
            }}
          >
            New Session
          </button>
        </div>
      </Show>
    </Modal>
  );
}
