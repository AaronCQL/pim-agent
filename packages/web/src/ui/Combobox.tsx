import {
  createEffect,
  createSignal,
  For,
  Show,
  type Accessor,
  type Element,
} from "solid-js";

import { ROW_ACTIVE } from "./classes";
import { Popover, type Point } from "./Popover";
import { followActive } from "./scroll";

export type ComboboxNavigation = {
  readonly activeIndex: Accessor<number>;
  /**
   * Wire to `mousemove`, never `mouseenter`: scrolling the active row into
   * view slides a row under a still cursor, and `mouseenter` would undo the key.
   */
  readonly setActiveIndex: (index: number) => void;
  /** True when the list consumed the key. */
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
};

export type ComboboxNavigationOptions = {
  readonly count: () => number;
  readonly open: () => boolean;
  readonly onSelect: (index: number) => void;
  readonly onDismiss: () => void;
  /** Defaults to every row. */
  readonly enabled?: (index: number) => boolean;
};

/** Wraps at both ends; Enter/Tab commit, Escape dismisses. An index below zero means no active row. */
export function createComboboxNavigation(
  options: ComboboxNavigationOptions
): ComboboxNavigation {
  const [activeIndex, setActiveIndex] = createSignal(0);

  const usable = (index: number): boolean => options.enabled?.(index) ?? true;

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
    // Updater form: Solid 2 batches writes, so two keys in one task would both read the old row.
    setActiveIndex((previous) => {
      let at = previous >= 0 ? previous : delta > 0 ? -1 : 0;
      // Bounded so an all-disabled list cannot loop forever.
      for (let step = 0; step < count; step += 1) {
        at = (at + delta + count) % count;
        if (usable(at)) {
          return at;
        }
      }
      return previous;
    });
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
        setActiveIndex(-1);
        move(1);
        break;
      case event.key === "End":
        setActiveIndex(-1);
        move(-1);
        break;
      case event.key === "Enter" && !event.shiftKey:
      case event.key === "Tab" && !event.shiftKey:
        if (
          options.count() === 0 ||
          activeIndex() < 0 ||
          !usable(activeIndex())
        ) {
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
  /** The current value, not the active row. */
  readonly selected?: boolean;
  /** Shown but skipped by the keyboard and unclickable. */
  readonly disabled?: boolean;
};

const ROW = "flex items-baseline gap-1ch rounded-lg px-2 py-1";

export const SEARCH =
  "w-full rounded-lg bg-neutral-900 px-2 py-1 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-500 focus:ring-neutral-600";

function tone(item: ComboboxItem, active: boolean): string {
  if (item.disabled === true) {
    return "text-neutral-600";
  }
  if (item.selected === false) {
    return active ? "text-neutral-100" : "text-neutral-350";
  }
  return active || item.selected === true
    ? "text-neutral-50"
    : "text-neutral-300";
}

/** Pair with `createComboboxNavigation`, which owns the active row. */
export function Combobox(props: {
  readonly open: boolean;
  readonly items: readonly ComboboxItem[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly onLeave?: () => void;
  readonly anchor: () => HTMLElement;
  /** Pointer position, for a menu opened by gesture. */
  readonly at?: () => Point | undefined;
  readonly match?: boolean;
  readonly min?: number;
  readonly place?: "above" | "below";
  readonly emptyLabel?: string;
  readonly header?: Element;
}) {
  let list!: HTMLUListElement;

  followActive(
    () => list,
    () => props.activeIndex,
    () => props.open
  );

  return (
    <Popover
      open={props.open}
      anchor={props.anchor}
      at={props.at}
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
        class="mr-[calc(-1*var(--scrollbar))] max-h-64 min-h-0 overflow-y-auto"
        onMouseLeave={() => {
          props.onLeave?.();
        }}
      >
        <Show when={props.items.length === 0 ? props.emptyLabel : undefined}>
          {(label) => <li class="px-2 py-1 text-neutral-500">{label()}</li>}
        </Show>
        <For each={props.items}>
          {(item, index) => {
            const dead = (): boolean => item.disabled === true;
            const active = (): boolean => index() === props.activeIndex;
            return (
              <li
                data-index={index()}
                role="option"
                aria-selected={active() ? "true" : "false"}
                {...(dead() ? { "aria-disabled": "true" } : {})}
                class={`${ROW} ${dead() ? "cursor-default" : "cursor-pointer"} ${active() ? ROW_ACTIVE : ""} ${tone(item, active())}`}
                onMouseMove={() => {
                  props.onActivate(dead() ? -1 : index());
                }}
                onMouseDown={(event: MouseEvent) => {
                  // Keep focus in the input, or its caret position is lost.
                  event.preventDefault();
                  if (dead()) {
                    return;
                  }
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
