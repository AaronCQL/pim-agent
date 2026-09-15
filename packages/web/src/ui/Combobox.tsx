import {
  createEffect,
  createSignal,
  For,
  Show,
  type Accessor,
  type Element,
} from "solid-js";

import { Popover, type Point } from "./Popover";

export type ComboboxNavigation = {
  readonly activeIndex: Accessor<number>;
  /**
   * The pointer's way in. Wire it to `mousemove`, never `mouseenter`: moving
   * the active row scrolls it into view, that scroll slides a row under a
   * still cursor, and the boundary event it fires would undo the keypress
   * that scrolled. Motion is the only pointer event a hand has to author.
   */
  readonly setActiveIndex: (index: number) => void;
  /** True when the key belonged to the list and the caller must not act on it. */
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
};

export type ComboboxNavigationOptions = {
  readonly count: () => number;
  readonly open: () => boolean;
  readonly onSelect: (index: number) => void;
  readonly onDismiss: () => void;
  /** Which rows the caret may rest on; a list without it has no dead rows. */
  readonly enabled?: (index: number) => boolean;
};

/**
 * Keyboard navigation for the `@` and `/` pickers: wrap at both ends, Enter
 * and Tab commit, ESC dismisses. An active index below zero is a list with no
 * row under the caret at all, which is how a menu opens: nothing is lit until
 * a key or the pointer says which row.
 */
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
    // Updater form, not read-then-write: Solid 2 applies writes on a microtask, so two keys in one task would move from the same row.
    setActiveIndex((previous) => {
      // From nothing, the first step lands on an end rather than beside one.
      let at = previous >= 0 ? previous : delta > 0 ? -1 : 0;
      // Bounded by the count: a list where every row is dead must not spin.
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
        // Both ends are a step from nowhere, so both skip what they must.
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
  /** The row in force, distinct from the active row the keyboard is standing on. */
  readonly selected?: boolean;
  /** Listed but not offered: the caret steps over it and neither a click nor Enter takes it. */
  readonly disabled?: boolean;
};

const ROW = "flex items-baseline gap-1ch rounded-lg px-2 py-1";

/** The filter box a panel puts above its rows. */
export const SEARCH =
  "w-full rounded-lg bg-neutral-900 px-2 py-1 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-500 focus:ring-neutral-600";

/**
 * The row under the caret is the brighter one: that contrast is the whole of
 * what "highlighted" means here. A list with something in force keeps three
 * readings, so the white stays the chosen row's rather than the caret's.
 */
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

/** The list half; the active row and the keys that move it belong to `createComboboxNavigation`. */
export function Combobox(props: {
  readonly open: boolean;
  readonly items: readonly ComboboxItem[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  /** The pointer left the rows: a menu unlights, a picker whose Enter needs a target says nothing. */
  readonly onLeave?: () => void;
  readonly anchor: () => HTMLElement;
  /** The pointer that summoned it, for a menu opened by gesture rather than by its trigger. */
  readonly at?: () => Point | undefined;
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
        class="max-h-64 min-h-0 w-full overflow-y-auto"
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
                class={`${ROW} ${dead() ? "cursor-default" : "cursor-pointer"} ${active() ? "bg-neutral-800" : ""} ${tone(item, active())}`}
                onMouseMove={() => {
                  // A dead row under the pointer lights nothing: leaving the
                  // row above lit would point at the wrong verb.
                  props.onActivate(dead() ? -1 : index());
                }}
                onMouseDown={(event: MouseEvent) => {
                  // Commit before the input loses focus, or the caret the completion is applied at is gone.
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
