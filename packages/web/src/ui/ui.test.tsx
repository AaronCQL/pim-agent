import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { Combobox, createComboboxNavigation } from "./Combobox";
import { Dialog } from "./Dialog";
import { Popover } from "./Popover";

type Nav = ReturnType<typeof createComboboxNavigation>;

function key(
  name: string,
  modifiers: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: name,
    cancelable: true,
    ...modifiers,
  });
  return event;
}

function navigation(count: number): {
  readonly press: (name: string, modifiers?: Partial<KeyboardEvent>) => boolean;
  readonly nav: Nav;
  readonly selected: number[];
  readonly dismissed: number[];
} {
  const selected: number[] = [];
  const dismissed: number[] = [];
  const nav = createRoot(() =>
    createComboboxNavigation({
      count: () => count,
      open: () => true,
      onSelect: (index) => selected.push(index),
      onDismiss: () => dismissed.push(1),
    })
  );
  // A browser delivers each keydown in its own task, which is when Solid 2
  // applies pending writes; `flush` is that boundary in a test.
  const press = (name: string, modifiers: Partial<KeyboardEvent> = {}) => {
    const consumed = nav.onKeyDown(key(name, modifiers));
    flush();
    return consumed;
  };
  return { press, nav, selected, dismissed };
}

describe("combobox keyboard navigation", () => {
  test("arrows move and wrap at both ends", () => {
    const { press, nav } = navigation(3);

    press("ArrowDown");
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(2);

    press("ArrowDown");
    expect(nav.activeIndex()).toBe(0);

    press("ArrowUp");
    expect(nav.activeIndex()).toBe(2);
  });

  test("the emacs pair moves the same way a terminal user expects", () => {
    const { press, nav } = navigation(3);

    press("n", { ctrlKey: true });
    expect(nav.activeIndex()).toBe(1);
    press("p", { ctrlKey: true });
    expect(nav.activeIndex()).toBe(0);
  });

  test("Home and End jump to the ends", () => {
    const { press, nav } = navigation(4);

    press("End");
    expect(nav.activeIndex()).toBe(3);
    press("Home");
    expect(nav.activeIndex()).toBe(0);
  });

  test("Enter and Tab both commit the active row", () => {
    const { press, selected } = navigation(3);

    press("ArrowDown");
    press("Enter");
    press("Tab");

    expect(selected).toEqual([1, 1]);
  });

  test("ESC dismisses and consumes the key", () => {
    const { nav, dismissed } = navigation(3);
    const event = key("Escape");

    expect(nav.onKeyDown(event)).toBe(true);
    expect(dismissed).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
  });

  test("any other key falls through so the input keeps it", () => {
    const { nav } = navigation(3);
    const event = key("a");

    expect(nav.onKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test("an empty list never commits and never traps Enter", () => {
    const { press, nav, selected } = navigation(0);

    expect(press("Enter")).toBe(false);
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(0);
    expect(selected).toEqual([]);
  });

  test("type-to-refine drops the active row back to the top", () => {
    createRoot(() => {
      const [count, setCount] = createSignal(5);
      const nav = createComboboxNavigation({
        count,
        open: () => true,
        onSelect: () => undefined,
        onDismiss: () => undefined,
      });

      nav.onKeyDown(key("End"));
      flush();
      expect(nav.activeIndex()).toBe(4);

      setCount(2);
      flush();
      expect(nav.activeIndex()).toBe(0);
    });
  });
});

describe("combobox list", () => {
  test("marks the active row and commits the one the mouse presses", () => {
    const host = mountPoint();
    const selected: number[] = [];
    render(
      () => (
        <Combobox
          open
          items={[{ label: "a.ts" }, { label: "b.ts", description: "second" }]}
          activeIndex={1}
          onActivate={() => undefined}
          onSelect={(index) => selected.push(index)}
        />
      ),
      host
    );
    flush();

    const rows = [...host.querySelectorAll('[role="option"]')];
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(rows[1]?.textContent).toContain("second");

    rows[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(selected).toEqual([0]);
  });
});

describe("platform wrappers", () => {
  test("the popover is hidden until it is open", () => {
    const host = mountPoint();
    const [open, setOpen] = createSignal(false);
    render(() => <Popover open={open()}>rows</Popover>, host);
    flush();

    const panel = host.querySelector("[popover]");
    expect(panel?.className).toContain("hidden");

    setOpen(true);
    flush();
    expect(panel?.className).not.toContain("hidden");
  });

  test("the dialog opens modally and reports its own close", () => {
    const host = mountPoint();
    const [open, setOpen] = createSignal(false);
    const closed: number[] = [];
    render(
      () => (
        <Dialog open={open()} label="Sessions" onClose={() => closed.push(1)}>
          <p>body</p>
        </Dialog>
      ),
      host
    );
    flush();

    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(false);

    setOpen(true);
    flush();
    expect(dialog.open).toBe(true);

    dialog.close();
    expect(closed).toEqual([1]);
  });
});
