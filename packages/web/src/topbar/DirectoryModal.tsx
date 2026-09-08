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

type Row = {
  readonly path: string;
  readonly label: string;
  readonly recent: boolean;
};

/** Where to work: the list navigates, the footer opens a new session in whatever it names. */
export function DirectoryModal(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
}) {
  const typing = createMediaQuery(KEYBOARD);
  const [input, setInput] = createSignal("");
  const [answer, setAnswer] = createSignal<{
    readonly asked: string;
    readonly listing: DirectoryListing;
  }>();
  const [failure, setFailure] = createSignal("");
  const [recents, setRecents] = createSignal<readonly string[]>([]);
  let box: HTMLInputElement | undefined;
  let generation = 0;

  const here = (): string => props.store.state.cwd;

  const cut = (): number =>
    /^[/~]/.test(input()) ? input().lastIndexOf("/") : -1;
  const anchor = createMemo((): string => {
    const at = cut();
    return at < 0 ? here() : input().slice(0, at) || "/";
  });
  const filter = (): string => input().slice(cut() + 1);

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
      setInput(`${untrack(here)}/`);
      setFailure("");
      void props.store
        .recentDirectories()
        .then(setRecents)
        .catch(() => undefined);
      if (untrack(typing) && box) {
        box.focus();
        box.setSelectionRange(0, box.value.length);
      }
    }
  );

  createEffect(
    () => ({ open: props.open, path: anchor() }),
    ({ open, path }) => {
      // Bump before the early return, or an answer in flight when the modal closes seeds the next open.
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
    const dotted = typed.startsWith(".");
    return [
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

  const target = createMemo((): string | undefined =>
    filter() === "" ? listing()?.path : rows()[navigation.activeIndex()]?.path
  );

  const settled = (): boolean => target() !== undefined;

  const footer = (): string => {
    const path = target();
    return path === undefined ? "Nowhere to open" : abbreviateHome(path);
  };

  const commit = (path: string): void => {
    props.onClose();
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
      header={<div class="font-bold leading-[--line]">Choose Directory</div>}
    >
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
