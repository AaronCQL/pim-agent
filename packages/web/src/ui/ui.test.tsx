import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, flush, Show } from "solid-js";

import { mountPoint } from "../test/dom";
import { Combobox, createComboboxNavigation } from "./Combobox";
import { Collapsible } from "./Collapsible";
import { Drawer } from "./Drawer";
import { Lightbox } from "./Lightbox";
import { Modal } from "./Modal";
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
    // Built inside the root and driven outside it: a keypress is imperative,
    // and a root's body is a pure scope, where a write is a defect the dev
    // runtime throws on.
    const { nav, setCount } = createRoot(() => {
      const [count, setCount] = createSignal(5);
      return {
        nav: createComboboxNavigation({
          count,
          open: () => true,
          onSelect: () => undefined,
          onDismiss: () => undefined,
        }),
        setCount,
      };
    });

    nav.onKeyDown(key("End"));
    flush();
    expect(nav.activeIndex()).toBe(4);

    setCount(2);
    flush();
    expect(nav.activeIndex()).toBe(0);
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
          anchor={() => host}
          emptyLabel="no matches"
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

  test("a tag is parked at the row's right edge, after the label", () => {
    const host = mountPoint();
    render(
      () => (
        <Combobox
          open
          items={[{ label: "Claude Opus 5.0", tag: "anthropic" }]}
          activeIndex={0}
          anchor={() => host}
          emptyLabel="no matches"
          onActivate={() => undefined}
          onSelect={() => undefined}
        />
      ),
      host
    );
    flush();

    const tag = host.querySelector('[role="option"] > :last-child')!;
    expect(tag.textContent).toBe("anthropic");
    expect(tag.className).toContain("ml-auto");
    expect(tag.className).toContain("text-xs");
  });
});

describe("platform wrappers", () => {
  test("the popover is hidden until it is open", () => {
    const host = mountPoint();
    const trigger = document.createElement("div");
    host.append(trigger);
    const [open, setOpen] = createSignal(false);
    render(
      () => (
        <Popover open={open()} anchor={() => trigger}>
          rows
        </Popover>
      ),
      host
    );
    flush();

    const panel = host.querySelector("[popover]");
    expect(panel?.className).toContain("hidden");

    setOpen(true);
    flush();
    expect(panel?.className).not.toContain("hidden");
  });

  // The regression this guards: with placement left to CSS anchor
  // positioning, an engine without it dropped every picker into the corner of
  // the viewport instead of over the element that opened it.
  test("the popover is measured onto its trigger, above it by default", () => {
    const host = mountPoint();
    const trigger = document.createElement("div");
    trigger.getBoundingClientRect = () =>
      ({
        left: 120,
        top: 400,
        right: 320,
        bottom: 440,
        width: 200,
        height: 40,
      }) as DOMRect;
    host.append(trigger);
    window.innerWidth = 1000;
    window.innerHeight = 800;

    const [open, setOpen] = createSignal(false);
    render(
      () => (
        <Popover open={open()} anchor={() => trigger}>
          rows
        </Popover>
      ),
      host
    );
    flush();
    setOpen(true);
    flush();

    const style = host.querySelector("[popover]")!.getAttribute("style")!;
    expect(style).toContain("position: fixed");
    expect(style).toContain("left: 120px");
    // Its bottom edge sits on the trigger's top edge, one gap clear of it.
    expect(style).toContain("bottom: 404px");
    expect(style).toContain("min-width: 200px");
    // The UA gives `[popover]` `inset: 0`; a `top` left standing would
    // stretch the panel from the top of the screen down to that `bottom`,
    // which is precisely how the picker used to look.
    expect(style).toContain("top: auto");
    expect(style).toContain("right: auto");
  });

  // The composer is pinned to the bottom of the window, so there is never
  // room below a trigger: the panel grows upward and stops at the viewport.
  test("the panel grows upward and is capped by the room above the trigger", () => {
    const host = mountPoint();
    const trigger = document.createElement("div");
    trigger.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 300,
        right: 120,
        bottom: 340,
        width: 100,
        height: 40,
      }) as DOMRect;
    host.append(trigger);
    window.innerWidth = 1000;
    window.innerHeight = 800;

    render(
      () => (
        <Popover open anchor={() => trigger}>
          rows
        </Popover>
      ),
      host
    );
    flush();

    const style = host.querySelector("[popover]")!.getAttribute("style")!;
    expect(style).toContain("bottom: 504px");
    expect(style).toContain("max-height: 288px");
  });

  // The composer's pickers read as part of the card they complete, so they
  // may not grow past it however long a description is.
  test("a matched panel is pinned to the trigger's width, not the viewport's", () => {
    const host = mountPoint();
    const trigger = document.createElement("div");
    trigger.getBoundingClientRect = () =>
      ({
        left: 20,
        top: 300,
        right: 320,
        bottom: 340,
        width: 300,
        height: 40,
      }) as DOMRect;
    host.append(trigger);
    window.innerWidth = 1000;
    window.innerHeight = 800;

    render(
      () => (
        <Popover open anchor={() => trigger} match>
          rows
        </Popover>
      ),
      host
    );
    flush();

    const style = host.querySelector("[popover]")!.getAttribute("style")!;
    expect(style).toContain("min-width: 300px");
    expect(style).toContain("max-width: 300px");
  });

  // The branch chip is a few characters wide and the branches under it are
  // not, so the panel is given a floor and pulled back inside the edge.
  test("a floored panel widens past its trigger, and never past the viewport", () => {
    const host = mountPoint();
    const trigger = document.createElement("div");
    trigger.getBoundingClientRect = () =>
      ({
        left: 180,
        top: 8,
        right: 260,
        bottom: 48,
        width: 80,
        height: 40,
      }) as DOMRect;
    host.append(trigger);
    window.innerHeight = 800;

    window.innerWidth = 360;
    render(
      () => (
        <Popover open anchor={() => trigger} min={300} place="below">
          rows
        </Popover>
      ),
      host
    );
    flush();

    const panel = host.querySelector("[popover]")!;
    expect(panel.getAttribute("style")).toContain("min-width: 300px");
    expect(panel.getAttribute("style")).toContain("left: 52px");

    window.innerWidth = 280;
    window.dispatchEvent(new Event("resize"));
    flush();

    expect(panel.getAttribute("style")).toContain("min-width: 264px");
    expect(panel.getAttribute("style")).toContain("left: 8px");
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

  // The spine hangs clear of the caret and is drawn in every state: starting
  // one `--line` down, it is zero-height on a closed row that fits, and beside
  // exactly the lines that overspilled on one that wraps. So it means "this
  // continues the row above" rather than "this row is open", and the caret is
  // left to say which.
  test("the rule is a spine from below the caret down, open or closed", () => {
    const host = mountPoint();
    render(
      () => (
        <Collapsible summary={<span>head</span>} spine="text-rose-400">
          <p>body</p>
        </Collapsible>
      ),
      host
    );
    flush();

    const spine = host.querySelector("summary > span + span")!;
    expect(spine.className).toContain("top-[--line]");
    expect(spine.className).toContain("text-rose-400");
    expect(spine.className).not.toContain("group-open:");
    expect(host.querySelector("details")?.open).toBe(false);
  });

  // 1.5px is not a hit target, so the grip is the whole 2ch gutter — and it
  // lives inside the `<summary>`, which is what makes the click the
  // platform's own rather than a handler of ours.
  test("the spine is a second grip on the disclosure, and says so on hover", () => {
    const host = mountPoint();
    render(
      () => (
        <Collapsible summary={<span>head</span>}>
          <p>body</p>
        </Collapsible>
      ),
      host
    );
    flush();

    const details = host.querySelector("details")!;
    const spine = host.querySelector("summary > span + span") as HTMLElement;
    expect(spine.className).toContain("w-2ch");
    expect(spine.className).toContain("cursor-pointer");
    // `group-hover`, so the grip lights from anywhere on the row — pointing
    // at the title and pointing at the rule are one gesture.
    expect(spine.className).toContain("group-hover:text-neutral-500");
    // Announced by the summary it grips, not twice over.
    expect(spine.getAttribute("aria-hidden")).toBe("true");

    spine.click();
    flush();
    expect(details.open).toBe(true);
    spine.click();
    flush();
    expect(details.open).toBe(false);
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

  // The drawer covers the session like any other overlay, so it answers the
  // phone gesture for "out of this" like any other overlay.
  test("Back closes the drawer rather than leaving the session", () => {
    const host = mountPoint();
    const [open, setOpen] = createSignal(true);
    const closed: number[] = [];
    render(
      () => (
        <Drawer
          open={open()}
          label="Sessions"
          onClose={() => {
            setOpen(false);
            closed.push(1);
          }}
        >
          <button type="button">pick</button>
        </Drawer>
      ),
      host
    );
    flush();
    const drawer = host.querySelector("dialog")!;
    expect(drawer.open).toBe(true);

    globalThis.dispatchEvent(new Event("popstate"));
    flush();

    expect(drawer.open).toBe(false);
    expect(closed).toEqual([1]);
  });

  // A browser delivers the `popstate` for `history.back()` in a later task;
  // happy-dom delivers it inline, which is the one ordering a handoff between
  // two overlays never sees.
  function deferredBack(): {
    readonly deliver: () => void;
    readonly restore: () => void;
  } {
    const real = history.back.bind(history);
    const pending: (() => void)[] = [];
    history.back = () => {
      pending.push(real);
    };
    return {
      deliver: () => {
        for (const run of pending.splice(0)) {
          run();
        }
      },
      restore: () => {
        history.back = real;
      },
    };
  }

  // The drawer's own rows open overlays: it closes as the next one opens, and
  // the entry it takes back must not be read as the Back that closes that one.
  test("an overlay opened from the drawer survives the drawer's own retraction", () => {
    const browser = deferredBack();
    const host = mountPoint();
    const [drawn, setDrawn] = createSignal(true);
    const [configuring, setConfiguring] = createSignal(false);
    render(
      () => (
        <>
          <Drawer
            open={drawn()}
            label="Sessions"
            onClose={() => setDrawn(false)}
          >
            <button
              type="button"
              onClick={() => {
                setDrawn(false);
                setConfiguring(true);
              }}
            >
              settings
            </button>
          </Drawer>
          <Modal
            open={configuring()}
            label="Settings"
            header={<span>Settings</span>}
            onClose={() => setConfiguring(false)}
          >
            <p>body</p>
          </Modal>
        </>
      ),
      host
    );
    flush();

    try {
      const [drawer, modal] = [...host.querySelectorAll("dialog")];
      drawer!.querySelector("button")!.click();
      flush();
      expect(drawer!.open).toBe(false);
      expect(modal!.open).toBe(true);

      browser.deliver();
      flush();
      expect(modal!.open).toBe(true);

      globalThis.dispatchEvent(new Event("popstate"));
      flush();
      expect(modal!.open).toBe(false);
    } finally {
      browser.restore();
    }
  });

  // Two overlays deep, Back is one step out, not the way back to the session.
  test("Back closes the innermost overlay only", () => {
    const host = mountPoint();
    const [configuring, setConfiguring] = createSignal(true);
    const [zoomed, setZoomed] = createSignal(true);
    render(
      () => (
        <>
          <Modal
            open={configuring()}
            label="Settings"
            header={<span>Settings</span>}
            onClose={() => setConfiguring(false)}
          >
            <p>body</p>
          </Modal>
          <Show when={zoomed()}>
            <Lightbox
              src="/files/shot.png"
              alt="shot.png"
              onClose={() => setZoomed(false)}
            />
          </Show>
        </>
      ),
      host
    );
    flush();
    expect(host.querySelectorAll("dialog")).toHaveLength(2);

    globalThis.dispatchEvent(new Event("popstate"));
    flush();
    expect(zoomed()).toBe(false);
    expect(configuring()).toBe(true);

    globalThis.dispatchEvent(new Event("popstate"));
    flush();
    expect(configuring()).toBe(false);
  });

  function lightbox(): {
    readonly dialog: HTMLDialogElement;
    readonly closed: number[];
  } {
    const host = mountPoint();
    const closed: number[] = [];
    render(
      () => (
        <Lightbox
          src="/files/shot.png"
          alt="shot.png"
          onClose={() => closed.push(1)}
        />
      ),
      host
    );
    flush();
    return { dialog: host.querySelector("dialog")!, closed };
  }

  // The regression this guards: the CSS reset zeroes `margin` on everything,
  // including the `margin: auto` the UA sheet centres a modal dialog with, so
  // a lightbox that does not name its own margin opens in the top-left corner.
  test("the picture is centred and legible over its own controls", () => {
    const { dialog } = lightbox();

    expect(dialog.open).toBe(true);
    expect(dialog.className).toContain("m-auto");
    // Inline, the line box under it would leave a strip of dialog below the
    // picture — backdrop to the eye, and to the click that closes it.
    expect(dialog.querySelector("img")!.className).toContain("block");
  });

  // There is no zoom of our own, so the way to see the pixels is the file
  // itself, in the viewer the browser already has.
  test("the original is one control away, and closing is the other", () => {
    const { dialog, closed } = lightbox();

    const original = dialog.querySelector("a")!;
    expect(original.getAttribute("href")).toBe("/files/shot.png");
    expect(original.getAttribute("target")).toBe("_blank");
    expect(original.getAttribute("aria-label")).toBe(
      "Open shot.png at full size"
    );

    dialog.querySelector("button")!.click();
    flush();
    expect(dialog.open).toBe(false);
    expect(closed).toEqual([1]);
  });

  // The phone gesture for "out of this". Without the pushed entry, Back leaves
  // the session that the picture was opened from.
  test("Back closes the lightbox rather than leaving the session", () => {
    const { dialog, closed } = lightbox();
    expect(history.state).toEqual({ pimModal: true });

    globalThis.dispatchEvent(new Event("popstate"));
    flush();

    expect(dialog.open).toBe(false);
    expect(closed).toEqual([1]);
  });
});

describe("chip menu", () => {
  function paint(search?: string): {
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
          value="claude/opus-5"
          {...(search === undefined ? {} : { search })}
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

  // A touch scroll of the list starts with a `pointerdown` on a row, and a
  // tap's `mousedown` only arrives at `touchend`: if that first pointer
  // dismissed the menu, the list could neither be scrolled nor chosen from.
  test("a pointer on the list itself does not close it", () => {
    const { host, chosen } = paint();
    host.querySelector("button")!.click();
    flush();

    const row = options(host)[1]!;
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flush();
    expect(options(host)).toHaveLength(2);

    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flush();
    expect(chosen).toEqual(["openai/gpt-6"]);
  });

  // Which row is in force and which row the keyboard is on are two different
  // facts, and the reader needs both: the arrow key moves one of them.
  test("the value in force is ticked, wherever the keyboard is standing", () => {
    const { host } = paint();
    const chip = host.querySelector("button")!;
    chip.click();
    flush();

    const ticked = (): readonly boolean[] =>
      options(host).map((row) =>
        row.innerHTML.includes("i-griddy-icons:check")
      );
    expect(ticked()).toEqual([true, false]);

    // And the rows it is not are written back in the chrome grey, so one
    // small mark is not the only thing saying which row is in force.
    expect(options(host)[0]?.className).toContain("text-neutral-50");
    expect(options(host)[1]?.className).toContain("text-neutral-350");

    chip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    flush();
    expect(options(host)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(ticked()).toEqual([true, false]);
    // Standing on a dimmed row lifts it, but not to the chosen row's white:
    // where the keyboard is and what is in force stay two readings.
    expect(options(host)[1]?.className).toContain("text-neutral-100");
  });

  test("a searchable menu filters its rows and chooses from what is left", async () => {
    const { host, chosen } = paint("Search models");
    host.querySelector("button")!.click();
    flush();

    const field = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    // The panel is shown by an effect of its own, so the focus that follows
    // it is a microtask behind the flush that opened the menu.
    await Promise.resolve();
    expect(document.activeElement).toBe(field);

    field.value = "gpt";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(options(host).map((row) => row.textContent)).toEqual(["GPT-6"]);

    // The one row left is the one Enter takes, and the index it arrives as
    // is an index into the rows on screen.
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    flush();
    expect(chosen).toEqual(["openai/gpt-6"]);
    // The box the keys were going to has gone with the panel, so the chip
    // takes them back rather than the page losing focus altogether.
    expect(document.activeElement).toBe(host.querySelector("button"));

    // Re-opening starts from the whole list and an empty box, not from what
    // was typed last.
    host.querySelector("button")!.click();
    flush();
    expect(options(host)).toHaveLength(2);
    expect(
      host.querySelector<HTMLInputElement>('input[type="text"]')!.value
    ).toBe("");
  });

  test("a menu without a search prop has no box to type into", () => {
    const { host } = paint();
    host.querySelector("button")!.click();
    flush();

    expect(host.querySelector('input[type="text"]')).toBeNull();
  });

  // The regression this guards: both panels registered their listeners from
  // inside an effect's callback and asked for `onCleanup` there, which is not
  // an owner — so nothing was ever released, and every open left another
  // listener on the document behind it.
  test("a panel releases every listener it took when it closes", () => {
    let outstanding = 0;
    for (const target of [window, document]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        outstanding += 1;
        add(type, listener, options);
      };
      target.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) => {
        outstanding -= 1;
        remove(type, listener, options);
      };
    }

    const host = mountPoint();
    const trigger = document.createElement("div");
    host.append(trigger);
    const [open, setOpen] = createSignal(false);
    render(
      () => (
        <Popover open={open()} anchor={() => trigger}>
          rows
        </Popover>
      ),
      host
    );
    const menu = paint();
    const chip = menu.host.querySelector("button")!;

    for (let opened = 0; opened < 3; opened += 1) {
      setOpen(true);
      chip.click();
      flush();
      setOpen(false);
      chip.click();
      flush();
    }

    expect(outstanding).toBe(0);
  });
});
