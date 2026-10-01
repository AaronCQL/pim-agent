import { createMemo, createSignal, Show, untrack } from "solid-js";

import { CHIP_BUTTON, PILL } from "./classes";
import {
  Combobox,
  createComboboxNavigation,
  SEARCH,
  type ComboboxItem,
} from "./Combobox";
import { createDisclosure } from "./disclosure";

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

export function Menu(props: {
  readonly label: string;
  readonly icon: string;
  readonly options: readonly MenuOption[];
  readonly value?: string;
  readonly title?: string;
  /** Defaults to "pill". */
  readonly shape?: "pill" | "chip";
  readonly place?: "above" | "below";
  /** Placeholder for an optional filter box. */
  readonly search?: string;
  readonly onOpen?: () => void;
  readonly onSelect: (value: string) => void;
}) {
  const [query, setQuery] = createSignal("");

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
    panel.close();
    if (option) {
      props.onSelect(option.value);
    }
  };

  const panel = createDisclosure({
    onClose: () => {
      // Not on open: the reset would not apply before the active row is picked.
      setQuery("");
    },
    onOpen: () => {
      props.onOpen?.();
      const at = untrack(() =>
        shown().findIndex((option) => option.value === props.value)
      );
      navigation.setActiveIndex(at === -1 ? 0 : at);
    },
  });

  const navigation = createComboboxNavigation({
    count: () => shown().length,
    open: panel.open,
    onSelect: choose,
    onDismiss: panel.close,
  });

  return (
    <div ref={panel.root} class="relative">
      <button
        ref={panel.trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={panel.open() ? "true" : "false"}
        {...(props.title === undefined ? {} : { title: props.title })}
        class={props.shape === "chip" ? CHIP_BUTTON : `${PILL} px-3 py-1.5`}
        onClick={panel.toggle}
        onKeyDown={(event: KeyboardEvent) => {
          navigation.onKeyDown(event);
        }}
      >
        <span class={`${props.icon} size-4 shrink-0`} aria-hidden="true" />
        <span class="max-w-40 truncate text-sm">{props.label}</span>
      </button>

      <Combobox
        open={panel.open()}
        anchor={panel.anchor}
        place={props.place}
        items={rows()}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={choose}
        emptyLabel={query() === "" ? "nothing to choose" : "no matches"}
        header={
          <Show when={props.search}>
            {(placeholder) => (
              <input
                ref={panel.field}
                type="text"
                placeholder={placeholder()}
                aria-label={placeholder()}
                class={`mb-1 ${SEARCH}`}
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
