import {
  createEffect,
  createSignal,
  For,
  Show,
  type Accessor,
  type Element,
} from "solid-js";

import { Popover } from "./Popover";

export type ComboboxNavigation = {
  readonly activeIndex: Accessor<number>;
  readonly setActiveIndex: (index: number) => void;
  /** True when the key belonged to the list and the caller must not act on it. */
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
};

export type ComboboxNavigationOptions = {
  readonly count: () => number;
  readonly open: () => boolean;
  readonly onSelect: (index: number) => void;
  readonly onDismiss: () => void;
};

/** Keyboard navigation for the `@` and `/` pickers: wrap at both ends, Enter and Tab commit, ESC dismisses. */
export function createComboboxNavigation(
  options: ComboboxNavigationOptions
): ComboboxNavigation {
  const [activeIndex, setActiveIndex] = createSignal(0);

  createEffect(
    () => options.count(),
    (count) => {
      setActiveIndex((previous) => (previous >= count ? 0 : previous));
    }
  );

  const move = (delta: number): void => {
    const count = options.count();
    if (count === 0) {
      return;
    }
    // Updater form, not read-then-write: Solid 2 applies writes on a microtask, so two keys in one task would move from the same row.
    setActiveIndex((previous) => (previous + delta + count) % count);
  };

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!options.open()) {
      return false;
    }
    const emacs = event.ctrlKey && !event.metaKey && !event.altKey;
    switch (true) {
      case event.key === "ArrowDown" || (emacs && event.key === "n"):
        move(1);
        break;
      case event.key === "ArrowUp" || (emacs && event.key === "p"):
        move(-1);
        break;
      case event.key === "Home":
        setActiveIndex(0);
        break;
      case event.key === "End":
        setActiveIndex(Math.max(0, options.count() - 1));
        break;
      case event.key === "Enter" && !event.shiftKey:
      case event.key === "Tab" && !event.shiftKey:
        if (options.count() === 0) {
          return false;
        }
        options.onSelect(activeIndex());
        break;
      case event.key === "Escape":
        options.onDismiss();
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  };

  return { activeIndex, setActiveIndex, onKeyDown };
}

export type ComboboxItem = {
  readonly label: string;
  readonly description?: string;
  readonly tag?: string;
  /** The row in force, distinct from the active row the keyboard is standing on. */
  readonly selected?: boolean;
};

const ROW = "flex cursor-pointer items-baseline gap-1ch rounded-lg px-2 py-1";

/** The filter box a panel puts above its rows. */
export const SEARCH =
  "w-full rounded-lg bg-neutral-900 px-2 py-1 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-500 focus:ring-neutral-600";

function tone(selected: boolean | undefined, active: boolean): string {
  if (selected === false) {
    return active ? "text-neutral-100" : "text-neutral-350";
  }
  return active || selected === true ? "text-neutral-50" : "";
}

/** The list half; the active row and the keys that move it belong to `createComboboxNavigation`. */
export function Combobox(props: {
  readonly open: boolean;
  readonly items: readonly ComboboxItem[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly anchor: () => HTMLElement;
  readonly match?: boolean;
  readonly min?: number;
  readonly place?: "above" | "below";
  /** Omitted where an empty list means no popover at all. */
  readonly emptyLabel?: string;
  readonly header?: Element;
}) {
  let list!: HTMLUListElement;

  createEffect(
    () => ({ index: props.activeIndex, open: props.open }),
    ({ index, open }) => {
      if (!open) {
        return;
      }
      list
        .querySelector(`[data-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  );

  return (
    <Popover
      open={props.open}
      anchor={props.anchor}
      match={props.match ?? false}
      min={props.min ?? 0}
      place={props.place}
      class="z-50 flex flex-col rounded-lg bg-neutral-850 p-1 text-sm ring-1 ring-neutral-700"
    >
      {props.header}
      <ul
        ref={(element: HTMLUListElement) => {
          list = element;
        }}
        role="listbox"
        class="max-h-64 min-h-0 w-full overflow-y-auto"
      >
        <Show when={props.items.length === 0 ? props.emptyLabel : undefined}>
          {(label) => <li class="px-2 py-1 text-neutral-500">{label()}</li>}
        </Show>
        <For each={props.items}>
          {(item, index) => {
            const active = (): boolean => index() === props.activeIndex;
            return (
              <li
                data-index={index()}
                role="option"
                aria-selected={active() ? "true" : "false"}
                class={`${ROW} ${active() ? "bg-neutral-800" : ""} ${tone(item.selected, active())}`}
                onMouseEnter={() => {
                  props.onActivate(index());
                }}
                onMouseDown={(event: MouseEvent) => {
                  // Commit before the input loses focus, or the caret the completion is applied at is gone.
                  event.preventDefault();
                  props.onSelect(index());
                }}
              >
                <span class="max-w-full shrink-0 truncate">{item.label}</span>
                <Show when={item.description}>
                  {(description) => (
                    <span class="min-w-0 truncate text-neutral-500">
                      {description()}
                    </span>
                  )}
                </Show>
                <Show when={item.selected === true}>
                  <span
                    class="i-griddy-icons:check size-4 shrink-0 self-center text-emerald-400"
                    aria-hidden="true"
                  />
                </Show>
                <Show when={item.tag}>
                  {(tag) => (
                    <span class="ml-auto shrink-0 pl-2ch text-xs text-neutral-500">
                      {tag()}
                    </span>
                  )}
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </Popover>
  );
}
