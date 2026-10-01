import { createMemo, createSignal, Show, untrack } from "solid-js";

import { ICON } from "./classes";
import {
  Combobox,
  createComboboxNavigation,
  type ComboboxItem,
} from "./Combobox";
import { createDisclosure } from "./disclosure";
import type { Point } from "./Popover";

export type RowMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
};

export type RowMenuControl = {
  readonly open: (at: Point) => void;
};

// A menu opened at a point has no trigger width to inherit.
const PANEL_WIDTH = 120;

/** A `⋯` menu, visible only on focus; pointers use right-click or long press via `control`. */
export function RowMenu(props: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  readonly control?: (control: RowMenuControl) => void;
}) {
  // Undefined when opened from the trigger.
  const [at, setAt] = createSignal<Point | undefined>(undefined);

  const rows = createMemo<readonly ComboboxItem[]>(() =>
    props.items.map((item) => ({
      label: item.label,
      ...(item.disabled === true ? { disabled: true } : {}),
    }))
  );

  const choose = (index: number): void => {
    const item = props.items[index];
    if (item?.disabled === true) {
      return;
    }
    panel.close();
    item?.onSelect();
  };

  const panel = createDisclosure({
    onOpen: () => {
      navigation.setActiveIndex(-1);
    },
  });

  const navigation = createComboboxNavigation({
    count: () => props.items.length,
    open: panel.open,
    onSelect: choose,
    onDismiss: panel.close,
    enabled: (index) => props.items[index]?.disabled !== true,
  });

  props.control?.({
    open: (where) => {
      // Android fires both the long press and `contextmenu`; keep the first point.
      if (untrack(panel.open)) {
        return;
      }
      setAt(where);
      panel.toggle();
    },
  });

  return (
    <div ref={panel.root} class="relative flex shrink-0 items-center">
      <button
        ref={panel.trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={panel.open() ? "true" : "false"}
        aria-label={props.label}
        title={props.label}
        class={`${ICON} sr-only focus:not-sr-only focus-visible:not-sr-only`}
        onClick={() => {
          setAt(undefined);
          panel.toggle();
        }}
        onKeyDown={(event: KeyboardEvent) => {
          navigation.onKeyDown(event);
        }}
      >
        <span
          class="i-griddy-icons:more-horizontal size-5"
          aria-hidden="true"
        />
      </button>

      <Show when={panel.open()}>
        <Combobox
          open={panel.open()}
          anchor={panel.anchor}
          at={at}
          place="below"
          min={PANEL_WIDTH}
          items={rows()}
          activeIndex={navigation.activeIndex()}
          onActivate={navigation.setActiveIndex}
          onLeave={() => {
            navigation.setActiveIndex(-1);
          }}
          onSelect={choose}
        />
      </Show>
    </div>
  );
}
