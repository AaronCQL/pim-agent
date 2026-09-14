import { createMemo, Show, untrack } from "solid-js";

import { ICON } from "./classes";
import {
  Combobox,
  createComboboxNavigation,
  type ComboboxItem,
} from "./Combobox";
import { createDisclosure } from "./disclosure";

export type RowMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
};

/** The menu, for whatever opens it other than its own trigger. */
export type RowMenuControl = {
  readonly open: () => void;
  readonly close: () => void;
};

/** Labels are short and the trigger is a glyph; this is the floor a verb reads at. */
const PANEL_WIDTH = 180;

/**
 * The `⋯` a row hangs its verbs on: dimmed rather than hidden, so it is there
 * to be found on a touch screen too.
 */
export function RowMenu(props: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  /** Hands the menu out, for a row that opens it by right-click. */
  readonly control?: (control: RowMenuControl) => void;
}) {
  const rows = createMemo<readonly ComboboxItem[]>(() =>
    props.items.map((item) => ({ label: item.label }))
  );

  const choose = (index: number): void => {
    const item = props.items[index];
    panel.close();
    item?.onSelect();
  };

  const panel = createDisclosure({
    onOpen: () => {
      navigation.setActiveIndex(0);
    },
  });

  const navigation = createComboboxNavigation({
    count: () => props.items.length,
    open: panel.open,
    onSelect: choose,
    onDismiss: panel.close,
  });

  props.control?.({
    open: () => {
      if (!untrack(panel.open)) {
        panel.toggle();
      }
    },
    close: panel.close,
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
        class={`${ICON} opacity-60 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100`}
        onClick={panel.toggle}
        onKeyDown={(event: KeyboardEvent) => {
          navigation.onKeyDown(event);
        }}
      >
        <span
          class="i-griddy-icons:more-horizontal size-5"
          aria-hidden="true"
        />
      </button>

      {/* Mounted by the opening: a row apiece would leave a panel per session standing. */}
      <Show when={panel.open()}>
        <Combobox
          open={panel.open()}
          anchor={panel.anchor}
          place="below"
          min={PANEL_WIDTH}
          items={rows()}
          activeIndex={navigation.activeIndex()}
          onActivate={navigation.setActiveIndex}
          onSelect={choose}
        />
      </Show>
    </div>
  );
}
