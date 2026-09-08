import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  untrack,
} from "solid-js";

import {
  Combobox,
  createComboboxNavigation,
  type ComboboxItem,
} from "./Combobox";
import { createMediaQuery, KEYBOARD } from "./media";

export type MenuOption = {
  readonly value: string;
  readonly label: string;
  readonly tag?: string;
};

function matching(
  options: readonly MenuOption[],
  query: string
): readonly MenuOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return options;
  }
  return options.filter((option) =>
    `${option.label} ${option.tag ?? ""}`.toLowerCase().includes(needle)
  );
}

/** A chip that opens a `Combobox` of choices above itself. */
export function Menu(props: {
  readonly label: string;
  readonly icon: string;
  readonly options: readonly MenuOption[];
  readonly value?: string;
  readonly title?: string;
  /** Places a filter box at the top of the list, with this as its placeholder. */
  readonly search?: string;
  readonly onOpen?: () => void;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const keyboard = createMediaQuery(KEYBOARD);
  let root!: HTMLDivElement;
  let chip!: HTMLButtonElement;
  let field: HTMLInputElement | undefined;

  const shown = createMemo(() => matching(props.options, query()));
  const rows = createMemo<readonly ComboboxItem[]>(() =>
    shown().map((option) => ({
      label: option.label,
      tag: option.tag,
      selected: option.value === props.value,
    }))
  );

  const choose = (index: number): void => {
    const option = shown()[index];
    setOpen(false);
    if (option) {
      props.onSelect(option.value);
    }
  };

  const navigation = createComboboxNavigation({
    count: () => shown().length,
    open,
    onSelect: choose,
    onDismiss: () => {
      setOpen(false);
    },
  });

  createEffect(
    () => open(),
    (isOpen) => {
      if (!isOpen) {
        // Clear on the way out: a reset written at open has not applied when the active row is chosen from it.
        setQuery("");
        // The box is uncontrolled, so it keeps what was typed until told otherwise.
        if (field) {
          field.value = "";
        }
        if (document.activeElement === field) {
          chip.focus();
        }
        return;
      }
      props.onOpen?.();
      // Untracked: a snapshot at the open, not a dependency of this effect.
      const at = untrack(() =>
        shown().findIndex((option) => option.value === props.value)
      );
      navigation.setActiveIndex(at === -1 ? 0 : at);
      // Focus in a microtask: the panel is shown by another effect, and a hidden field cannot take focus.
      if (untrack(keyboard)) {
        queueMicrotask(() => {
          field?.focus();
        });
      }
      const dismiss = (event: PointerEvent): void => {
        // Test the whole menu, chip and panel: a chip-only test closes the list under a touch scroll of a row.
        if (!root.contains(event.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener("pointerdown", dismiss, true);
      // Return the cleanup: an effect callback is not an owner, so `onCleanup` here would never run.
      return () => {
        document.removeEventListener("pointerdown", dismiss, true);
      };
    }
  );

  return (
    <div
      ref={(element: HTMLDivElement) => {
        root = element;
      }}
      class="relative"
    >
      <button
        ref={(element: HTMLButtonElement) => {
          chip = element;
        }}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open() ? "true" : "false"}
        {...(props.title === undefined ? {} : { title: props.title })}
        class="flex items-center justify-center gap-1.5 rounded-full bg-neutral-900 px-3 py-1.5 text-neutral-350 ring-neutral-600 hover:text-neutral-100 hover:ring-1"
        onClick={() => {
          setOpen((was) => !was);
        }}
        onKeyDown={(event: KeyboardEvent) => {
          navigation.onKeyDown(event);
        }}
      >
        <span class={`${props.icon} size-4 shrink-0`} aria-hidden="true" />
        <span class="max-w-40 truncate text-sm">{props.label}</span>
      </button>

      <Combobox
        open={open()}
        anchor={() => chip}
        items={rows()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={choose}
        emptyLabel={query() === "" ? "nothing to choose" : "no matches"}
        header={
          <Show when={props.search}>
            {(placeholder) => (
              <input
                ref={(element: HTMLInputElement) => {
                  field = element;
                }}
                type="text"
                placeholder={placeholder()}
                aria-label={placeholder()}
                class="mb-1 w-full rounded-lg bg-neutral-900 px-2 py-1 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-500 focus:ring-neutral-600"
                onInput={(event: InputEvent) => {
                  setQuery((event.target as HTMLInputElement).value);
                  navigation.setActiveIndex(0);
                }}
                onKeyDown={(event: KeyboardEvent) => {
                  navigation.onKeyDown(event);
                }}
              />
            )}
          </Show>
        }
      />
    </div>
  );
}
