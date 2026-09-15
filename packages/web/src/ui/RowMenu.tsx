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
  /** Offered but not here: greyed, and the menu keeps its shape rather than shuffling the verbs under a thumb. */
  readonly disabled?: boolean;
};

/** The menu, for whatever opens it other than its own trigger. */
export type RowMenuControl = {
  /** `at` is where the gesture landed; the panel drops from there. */
  readonly open: (at: Point) => void;
  readonly close: () => void;
};

/**
 * The floor a verb reads at, and the width the placement keeps clear: a menu
 * summoned by a finger has no trigger to measure, so without this one opened
 * near the right edge of the screen would be a column of broken words. Close
 * to what the labels want, so a highlighted row is padding and not a field.
 */
const PANEL_WIDTH = 120;

/**
 * The `⋯` a row hangs its verbs on. A pointer opens it by right-click and a
 * finger by long press, so the glyph is painted out until a caret lands on it:
 * the keyboard and a screen reader keep a control the gestures cannot offer.
 */
export function RowMenu(props: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  /** Hands the menu out, for a row that opens it by right-click. */
  readonly control?: (control: RowMenuControl) => void;
}) {
  // Where the gesture that opened it landed, if a gesture did; a press on the
  // trigger clears it and the panel goes back to hanging off the glyph.
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
      // Nothing is lit until a pointer or a key picks a row: a menu that opens
      // with its first verb highlighted reads as though that verb is the one
      // about to happen.
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
      // A gesture that finds the menu already up leaves it exactly where it
      // stands: one long press on Android is answered twice, by the hold and
      // by the `contextmenu` that follows it a moment later, and taking the
      // second one's point would jog the panel out from under the finger.
      if (untrack(panel.open)) {
        return;
      }
      setAt(where);
      panel.toggle();
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

      {/* Mounted by the opening: a row apiece would leave a panel per session standing. */}
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
