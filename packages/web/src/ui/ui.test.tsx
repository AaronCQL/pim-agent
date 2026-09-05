import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { Combobox, createComboboxNavigation } from "./Combobox";
import { Collapsible } from "./Collapsible";
import { Drawer } from "./Drawer";
import { Menu } from "./Menu";
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

  test("the disclosure caret is the only glyph, and it can carry state", () => {
    const host = mountPoint();
    render(
      () => (
        <Collapsible summary={<span>head</span>} caret="bg-rose-400" open>
          <p>body</p>
        </Collapsible>
      ),
      host
    );
    flush();

    const caret = host.querySelector("summary > span")!;
    expect(caret.className).toContain(
      "i-griddy-icons:chevron-right-small-filled"
    );
    expect(caret.className).toContain("bg-rose-400");
    expect(host.querySelector("details")?.open).toBe(true);
  });

  test("the drawer opens modally, hosts its content and closes on select", () => {
    const host = mountPoint();
    const [open, setOpen] = createSignal(false);
    const closed: number[] = [];
    render(
      () => (
        <Drawer open={open()} label="Sessions" onClose={() => closed.push(1)}>
          <button type="button" onClick={() => setOpen(false)}>
            pick
          </button>
        </Drawer>
      ),
      host
    );
    flush();

    const drawer = host.querySelector("dialog")!;
    expect(drawer.open).toBe(false);

    setOpen(true);
    flush();
    expect(drawer.open).toBe(true);
    expect(drawer.textContent).toContain("pick");

    drawer.querySelector("button")!.click();
    flush();
    expect(drawer.open).toBe(false);
    expect(closed).toEqual([1]);
  });
});

describe("chip menu", () => {
  function paint(): {
    readonly host: HTMLElement;
    readonly chosen: string[];
    readonly opened: number[];
  } {
    const host = mountPoint();
    const chosen: string[] = [];
    const opened: number[] = [];
    render(
      () => (
        <Menu
          label="claude/opus-5"
          icon="i-griddy-icons:robot"
          anchor="--pim-model"
          value="claude/opus-5"
          options={[
            { value: "claude/opus-5", label: "Opus 5" },
            { value: "openai/gpt-6", label: "GPT-6" },
          ]}
          onOpen={() => opened.push(1)}
          onSelect={(value) => chosen.push(value)}
        />
      ),
      host
    );
    flush();
    return { host, chosen, opened };
  }

  /** Rows the reader can reach; a closed popover keeps its list mounted. */
  function options(host: HTMLElement): readonly Element[] {
    const panel = host.querySelector("[popover]");
    if (panel === null || panel.className.includes("hidden")) {
      return [];
    }
    return [...panel.querySelectorAll('[role="option"]')];
  }

  test("the chip asks for its options each time it is opened", () => {
    const { host, opened } = paint();

    expect(options(host)).toHaveLength(0);
    host.querySelector("button")!.click();
    flush();

    expect(opened).toEqual([1]);
    expect(options(host).map((row) => row.textContent)).toEqual([
      "Opus 5",
      "GPT-6",
    ]);
    // The keyboard starts on what the chip already says.
    expect(options(host)[0]?.getAttribute("aria-selected")).toBe("true");
  });

  test("choosing closes the menu and reports the value, not the label", () => {
    const { host, chosen } = paint();
    host.querySelector("button")!.click();
    flush();

    options(host)[1]!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    );
    flush();

    expect(chosen).toEqual(["openai/gpt-6"]);
    expect(options(host)).toHaveLength(0);
  });

  test("a pointer anywhere else closes it, a pointer on the chip does not", () => {
    const { host } = paint();
    const chip = host.querySelector("button")!;
    chip.click();
    flush();

    chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flush();
    expect(options(host)).toHaveLength(2);

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true })
    );
    flush();
    expect(options(host)).toHaveLength(0);
  });
});
