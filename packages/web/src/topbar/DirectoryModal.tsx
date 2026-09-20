import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";

import type { DirectoryListing } from "#core/shared/Directories";
import type { SessionStore } from "../session/SessionStore";
import { ACTION, FIELD, ICON, ROW_ACTIVE } from "../ui/classes";
import { createComboboxNavigation } from "../ui/Combobox";
import { createMediaQuery, KEYBOARD } from "../ui/media";
import { Modal } from "../ui/Modal";
import { followActive } from "../ui/scroll";

type Row = {
  readonly path: string;
  readonly label: string;
  /** The row that makes what was typed, rather than walking to something that is already there. */
  readonly create: boolean;
};

/** Where to work: the rows navigate, the button opens a new session in whatever the box names. */
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
  const [refused, setRefused] = createSignal("");
  let box: HTMLInputElement | undefined;
  let list: HTMLUListElement | undefined;
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
      setRefused("");
      if (untrack(typing) && box) {
        // Only the selection, which is the element's and waits there for the
        // caret `autofocus` brings: this runs while the dialog is still
        // display:none, where a `focus()` of its own could not take.
        box.setSelectionRange(0, box.value.length);
      }
    }
  );

  createEffect(
    () => ({ open: props.open, path: anchor(), store: props.store }),
    ({ open, path, store }) => {
      // Bump before the early return, or an answer in flight when the modal closes seeds the next open.
      const mine = ++generation;
      if (!open) {
        return;
      }
      void store.listDirectory(path).then(
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

  /**
   * A `/` in the box re-anchors it, so a filter never holds one: what the
   * create row makes is a single name inside the directory being browsed, and
   * the `mkdir` behind it is non-recursive by construction.
   */
  const within = (name: string): string =>
    `${anchor().replace(/\/$/, "")}/${name}`;

  const named = createMemo((): string | undefined => {
    const name = filter();
    return name === ""
      ? undefined
      : listing()?.entries.find((entry) => entry.name === name)?.path;
  });

  const rows = createMemo<readonly Row[]>(() => {
    const typed = filter().toLowerCase();
    const dotted = typed.startsWith(".");
    return [
      ...(listing()?.entries ?? [])
        .filter(
          (entry) =>
            (dotted || !entry.name.startsWith(".")) &&
            entry.name.toLowerCase().includes(typed)
        )
        .map((entry) => ({
          path: entry.path,
          label: entry.name,
          create: false,
        })),
      ...(filter() !== "" && named() === undefined
        ? [
            {
              path: within(filter()),
              label: `New folder “${filter()}”`,
              create: true,
            },
          ]
        : []),
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

  followActive(
    () => list,
    navigation.activeIndex,
    () => props.open
  );

  /**
   * The box's value is the whole of what the rows are: a step into a folder
   * and a keystroke of filter both replace the list under the caret, and a
   * caret that only clamped would land on a row nobody chose. Opening counts
   * too: the box selects its whole path for retyping, and a caret left where
   * the last visit parked it would be the one thing that did not start over.
   */
  createEffect(
    () => ({ text: input(), open: props.open }),
    () => {
      navigation.setActiveIndex(0);
    }
  );

  const target = createMemo((): string | undefined =>
    filter() === "" ? listing()?.path : named()
  );

  const commit = (path: string): void => {
    props.onClose();
    void props.store.openDirectory(path).catch(() => undefined);
  };

  const step = (path: string): void => {
    setRefused("");
    setInput(`${path}/`);
  };

  /** False at the root of the filesystem, which is its own parent. */
  const stepOut = (): boolean => {
    const parent = listing()?.parent;
    if (parent === undefined) {
      return false;
    }
    step(parent);
    return true;
  };

  const choose = (row: Row): void => {
    if (!row.create) {
      step(row.path);
      return;
    }
    void props.store.createDirectory(row.path).then(
      () => {
        step(row.path);
      },
      (error: Error) => {
        setRefused(error.message);
      }
    );
  };

  const message = (): string =>
    refused() ||
    failure() ||
    (rows().length === 0 ? "Nothing to open in here." : "");

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const path = target();
      if (path !== undefined) {
        commit(path);
      }
      return;
    }
    // Before the list is offered the key: bare ArrowUp is the caret's.
    if ((event.altKey || event.metaKey) && event.key === "ArrowUp") {
      if (stepOut()) {
        event.preventDefault();
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
      size="column"
      onKeyDown={onKeyDown}
      header={<div class="font-bold leading-[--line]">Choose Directory</div>}
    >
      <Show when={props.open}>
        <div class="flex items-center gap-2 border-b border-neutral-700 p-3">
          <button
            type="button"
            aria-label="Parent directory"
            title="Parent directory (Alt+↑)"
            disabled={listing()?.parent === undefined}
            class={`${ICON} disabled:opacity-40`}
            onClick={() => {
              stepOut();
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
            autofocus={typing()}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            aria-label="Directory path"
            class={FIELD}
            onInput={(event: InputEvent) => {
              setRefused("");
              setInput((event.currentTarget as HTMLInputElement).value);
            }}
          />
        </div>

        <ul
          ref={(element: HTMLUListElement) => {
            list = element;
          }}
          role="listbox"
          class="min-h-0 flex-1 overflow-y-auto p-1 pr-[calc(0.25rem-var(--scrollbar))] text-sm"
        >
          <Show when={message()}>
            {(text) => <li class="px-2 py-1 text-neutral-500">{text()}</li>}
          </Show>
          <For each={rows()}>
            {(row, index) => {
              const active = (): boolean =>
                index() === navigation.activeIndex();
              return (
                <li
                  data-index={index()}
                  role="option"
                  aria-selected={active() ? "true" : "false"}
                  class={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 ${active() ? `${ROW_ACTIVE} text-neutral-50` : ""}`}
                  onMouseMove={() => {
                    navigation.setActiveIndex(index());
                  }}
                  onClick={() => {
                    choose(row);
                  }}
                >
                  <span
                    class={`size-4 shrink-0 ${row.create ? "i-griddy-icons:plus" : "i-griddy-icons:folder"}`}
                    aria-hidden="true"
                  />
                  <span class="min-w-0 truncate">{row.label}</span>
                </li>
              );
            }}
          </For>
        </ul>

        <div class="flex shrink-0 items-center justify-end border-t border-neutral-700 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            disabled={target() === undefined}
            aria-label="Start a new session in this directory"
            title="Start a new session in this directory (Ctrl+Enter)"
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
