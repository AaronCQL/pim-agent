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
  /** Right-aligned qualifier on the row, e.g. a model's provider. */
  readonly tag?: string;
};

/**
 * Substring, case-insensitive, over the label and its tag, and in the order
 * the caller gave. Not the fuzzy ranker the `@` and `/` pickers use: that one
 * scores a query against thousands of paths, and it would earn a browser
 * bundle for its trouble here to reorder a list a reader is already looking
 * at — a menu that resorted itself under the second keystroke is harder to
 * hit than one that only got shorter.
 */
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

/**
 * A chip that opens a list of choices above itself: the composer's model and
 * thinking pickers, and nothing else so far.
 *
 * The list is the `Combobox` the `@` and `/` pickers use, so the two overlays
 * in the composer look the same and answer the same keys; what this adds is
 * the trigger and its open/closed state, which a completion surface over a
 * text field does not have.
 *
 * Dismissal is a capture-phase `pointerdown` while open, rather than
 * `popover="auto"`'s light dismiss: the popover is `manual`, and the two
 * mechanisms would disagree about who closed it — the chip's own click would
 * re-open what the light dismiss had just closed.
 *
 * "Outside" is measured against the whole menu, chip and panel together, and
 * not the chip alone. A touch scroll of the list opens with a `pointerdown`
 * on a row, so a chip-only test closes the menu under the finger before it
 * moves — and takes the tap with it, since touch defers its compat
 * `mousedown` to `touchend`, by which point the row is unmounted. A mouse
 * hides the bug: its `mousedown` follows in the same task, while the list is
 * still there.
 */
export function Menu(props: {
  readonly label: string;
  readonly icon: string;
  readonly options: readonly MenuOption[];
  readonly value?: string;
  readonly title?: string;
  /**
   * Places a filter box at the top of the list, with this as its placeholder.
   * Given only to a list too long to read down: a server's models run past
   * the panel's height, while the levels a model thinks at are four rows
   * nobody would type at.
   */
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
        // Cleared on the way out rather than on the way in, so the list the
        // next open lands on is the whole one before any of it is read: a
        // reset written as the menu opens has not been applied yet when the
        // active row below is chosen from it.
        setQuery("");
        // The box itself is uncontrolled: the signal above is what the rows
        // obey, and the element keeps whatever was typed into it until it is
        // told otherwise — so the next open would read as a filtered list
        // that is showing everything.
        if (field) {
          field.value = "";
        }
        // The filter box is inside the panel that just went away, so a
        // keyboard left standing on it would be typing at nothing: the chip
        // is where the focus was before it, and where the next Tab is
        // measured from.
        if (document.activeElement === field) {
          chip.focus();
        }
        return;
      }
      props.onOpen?.();
      // The current value is where the keyboard starts, so opening the menu
      // lands on what the chip already says.
      // Untracked because it is a snapshot taken at the open: this callback
      // is not a tracking scope, and the list changing later is the filter
      // doing its job, not a reason to re-run the open.
      const at = untrack(() =>
        shown().findIndex((option) => option.value === props.value)
      );
      navigation.setActiveIndex(at === -1 ? 0 : at);
      // Only where the keyboard is already out. A soft one is drawn over the
      // page when a field takes focus, and the panel opens upward from a chip
      // at the bottom of the screen — so focusing here would cover the list
      // with the keys, for a reader who tapped to browse rather than to type.
      // The panel is shown by an effect of its own, and a hidden field cannot
      // take focus: the microtask waits for that to have happened.
      if (untrack(keyboard)) {
        queueMicrotask(() => {
          field?.focus();
        });
      }
      const dismiss = (event: PointerEvent): void => {
        // The panel is in the top layer but still a DOM child of the root,
        // so one containment test covers both halves.
        if (!root.contains(event.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener("pointerdown", dismiss, true);
      // Returned rather than registered with `onCleanup`: an effect callback
      // is not an owner, so a cleanup asked for there is never run at all and
      // every open leaves another dismiss listener on the document.
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
                  // The rows underneath are a different list now, and the
                  // one the keyboard was standing on is not in it.
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
