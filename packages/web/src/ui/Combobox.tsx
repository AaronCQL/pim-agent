import { createEffect, createSignal, For, Show, type Accessor } from "solid-js";

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

/**
 * Keyboard navigation for the `@` and `/` pickers — the one part of this
 * client the platform does not already provide, and the reason the "no
 * component library" decision is affordable at all.
 *
 * The semantics are not invented here: they are the ones
 * `packages/tui/src/extensions/{file,command}-picker` drive against pi-tui,
 * ported with the event source swapped from stdin to `keydown`. Wrap at both
 * ends, Enter and Tab both commit, ESC dismisses without touching the draft,
 * and the emacs pair (`Ctrl-N`/`Ctrl-P`) works because a terminal user's
 * fingers already expect it.
 *
 * Type-to-refine needs no handling: an unconsumed key edits the input, the
 * query changes, the caller re-queries, and the clamp below drops the active
 * row back to the top.
 */
export function createComboboxNavigation(
  options: ComboboxNavigationOptions
): ComboboxNavigation {
  const [activeIndex, setActiveIndex] = createSignal(0);

  createEffect(
    () => options.count(),
    (count) => {
      if (activeIndex() >= count) {
        setActiveIndex(0);
      }
    }
  );

  const move = (delta: number): void => {
    const count = options.count();
    if (count === 0) {
      return;
    }
    // Updater form, not a read-then-write: Solid 2 applies writes on a
    // microtask, so two keys inside one task would otherwise both move from
    // the same starting row.
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
};

/**
 * The list half. Presentation only: the active row and every key that moves it
 * belong to `createComboboxNavigation`, so the same list serves both pickers.
 */
export function Combobox(props: {
  readonly open: boolean;
  readonly items: readonly ComboboxItem[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
  readonly anchor?: string;
  readonly emptyLabel?: string;
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
      {...(props.anchor === undefined ? {} : { anchor: props.anchor })}
      class="z-50 max-h-64 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 p-1 text-sm shadow-xl"
    >
      <ul
        ref={(element: HTMLUListElement) => {
          list = element;
        }}
        role="listbox"
      >
        <Show when={props.items.length === 0}>
          <li class="px-2 py-1 text-neutral-500">
            {props.emptyLabel ?? "no matches"}
          </li>
        </Show>
        <For each={props.items}>
          {(item, index) => (
            <li
              data-index={index()}
              role="option"
              aria-selected={index() === props.activeIndex ? "true" : "false"}
              class={{
                "flex cursor-pointer items-baseline gap-2 rounded px-2 py-1": true,
                "bg-sky-900/60 text-neutral-100": index() === props.activeIndex,
              }}
              onMouseEnter={() => {
                props.onActivate(index());
              }}
              onMouseDown={(event: MouseEvent) => {
                // Commit before the input loses focus, or the caret position
                // the completion is applied at is already gone.
                event.preventDefault();
                props.onSelect(index());
              }}
            >
              <span class="shrink-0 font-mono">{item.label}</span>
              <Show when={item.description}>
                {(description) => (
                  <span class="min-w-0 truncate text-neutral-500">
                    {description()}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Popover>
  );
}
