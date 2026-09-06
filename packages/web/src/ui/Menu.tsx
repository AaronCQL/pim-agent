import { createEffect, createSignal, onCleanup } from "solid-js";

import { Combobox, createComboboxNavigation } from "./Combobox";

export type MenuOption = {
  readonly value: string;
  readonly label: string;
  /** Right-aligned qualifier on the row, e.g. a model's provider. */
  readonly tag?: string;
};

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
  readonly onOpen?: () => void;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let chip!: HTMLButtonElement;

  const choose = (index: number): void => {
    const option = props.options[index];
    setOpen(false);
    if (option) {
      props.onSelect(option.value);
    }
  };

  const navigation = createComboboxNavigation({
    count: () => props.options.length,
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
        return;
      }
      props.onOpen?.();
      // The current value is where the keyboard starts, so opening the menu
      // lands on what the chip already says.
      const at = props.options.findIndex(
        (option) => option.value === props.value
      );
      navigation.setActiveIndex(at === -1 ? 0 : at);
      const dismiss = (event: PointerEvent): void => {
        // The panel is in the top layer but still a DOM child of the root,
        // so one containment test covers both halves.
        if (!root.contains(event.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener("pointerdown", dismiss, true);
      onCleanup(() => {
        document.removeEventListener("pointerdown", dismiss, true);
      });
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
        items={props.options}
        activeIndex={navigation.activeIndex()}
        onActivate={navigation.setActiveIndex}
        onSelect={choose}
        emptyLabel="nothing to choose"
      />
    </div>
  );
}
