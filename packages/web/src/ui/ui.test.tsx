import "../test/dom";

import { render } from "@solidjs/web";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal, flush, Show } from "solid-js";

import { mountPoint } from "../test/dom";
import { fakeViewport } from "../test/viewport";
import { Combobox, createComboboxNavigation } from "./Combobox";
import { Collapsible } from "./Collapsible";
import { Drawer } from "./Drawer";
import { ImageLightbox } from "./Lightbox";
import { Modal } from "./Modal";
import { Menu } from "./Menu";
import { Popover } from "./Popover";
import { createBottomPin, type BottomPin } from "./scroll";

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

function navigation(
  count: number,
  enabled?: (index: number) => boolean
): {
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
      ...(enabled === undefined ? {} : { enabled }),
    })
  );
  // Each keydown is its own task in a browser; `flush` stands in for that.
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

  test("the caret steps over a dead row rather than resting on it", () => {
    const { press, nav, selected } = navigation(4, (index) => index % 2 === 0);

    nav.setActiveIndex(-1);
    flush();
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(0);
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(2);
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(0);
    press("ArrowUp");
    expect(nav.activeIndex()).toBe(2);

    press("End");
    expect(nav.activeIndex()).toBe(2);
    press("Home");
    expect(nav.activeIndex()).toBe(0);

    press("Enter");
    expect(selected).toEqual([0]);
  });

  test("a list of nothing but dead rows neither moves nor spins", () => {
    const { press, nav, selected } = navigation(3, () => false);

    nav.setActiveIndex(-1);
    flush();
    expect(press("ArrowDown")).toBe(true);
    expect(nav.activeIndex()).toBe(-1);
    expect(press("Enter")).toBe(false);
    expect(selected).toEqual([]);
  });

  test("a menu opened with nothing lit takes the first row on the way down and the last on the way up", () => {
    const { press, nav } = navigation(3);

    nav.setActiveIndex(-1);
    flush();
    press("ArrowDown");
    expect(nav.activeIndex()).toBe(0);

    nav.setActiveIndex(-1);
    flush();
    press("ArrowUp");
    expect(nav.activeIndex()).toBe(2);
  });

  test("type-to-refine drops the active row back to the top", () => {
    // Writes inside a root's body throw in dev, so drive it from outside.
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

  test("the pointer hands the caret over, and a dead row takes nothing", () => {
    const host = mountPoint();
    const activated: number[] = [];
    render(
      () => (
        <Combobox
          open
          items={[{ label: "a.ts" }, { label: "b.ts", disabled: true }]}
          activeIndex={0}
          anchor={() => host}
          onActivate={(index) => activated.push(index)}
          onSelect={() => undefined}
        />
      ),
      host
    );
    flush();

    const rows = [...host.querySelectorAll('[role="option"]')];
    expect(rows[0]?.className).toContain("bg-neutral-800");
    expect(rows[1]?.className).not.toContain("bg-neutral-800");

    rows[1]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    rows[0]?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(activated).toEqual([-1, 0]);
  });
});

describe("platform wrappers", () => {
  function popover(
    rect: { left: number; top: number; width: number; height: number },
    props: Omit<
      Parameters<typeof Popover>[0],
      "open" | "anchor" | "children"
    > = {},
    viewportWidth = 1000
  ): HTMLElement {
    const host = mountPoint();
    const trigger = document.createElement("div");
    trigger.getBoundingClientRect = () =>
      ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
      }) as DOMRect;
    host.append(trigger);
    window.innerWidth = viewportWidth;
    window.innerHeight = 800;
    render(
      () => (
        <Popover open anchor={() => trigger} {...props}>
          rows
        </Popover>
      ),
      host
    );
    flush();
    return host.querySelector("[popover]")!;
  }

  test("the popover sits above its trigger by default, capped by the room there", () => {
    const style = popover({
      left: 120,
      top: 400,
      width: 200,
      height: 40,
    }).getAttribute("style")!;

    expect(style).toContain("position: fixed");
    expect(style).toContain("left: 120px");
    expect(style).toContain("bottom: 404px");
    expect(style).toContain("min-width: 200px");
    expect(style).toContain("max-height: 388px");
    // Overrides the UA's `[popover] { inset: 0 }`.
    expect(style).toContain("top: auto");
    expect(style).toContain("right: auto");
  });

  test("a matched panel is pinned to the trigger's width, not the viewport's", () => {
    const style = popover(
      { left: 20, top: 300, width: 300, height: 40 },
      { match: true }
    ).getAttribute("style")!;

    expect(style).toContain("min-width: 300px");
    expect(style).toContain("max-width: 300px");
  });

  test("a floored panel widens past its trigger, and never past the viewport", () => {
    const panel = popover(
      { left: 180, top: 8, width: 80, height: 40 },
      { min: 300, place: "below" },
      360
    );
    expect(panel.getAttribute("style")).toContain("min-width: 300px");
    expect(panel.getAttribute("style")).toContain("left: 52px");

    window.innerWidth = 280;
    window.dispatchEvent(new Event("resize"));
    flush();

    expect(panel.getAttribute("style")).toContain("min-width: 264px");
    expect(panel.getAttribute("style")).toContain("left: 8px");
  });

  test("a panel summoned by a pointer drops from it, not from its trigger", () => {
    const panel = popover(
      { left: 300, top: 40, width: 20, height: 20 },
      { at: () => ({ x: 120, y: 500 }), min: 180, place: "below" }
    );
    expect(panel.getAttribute("style")).toContain("left: 120px");
    expect(panel.getAttribute("style")).toContain("top: 504px");
    expect(panel.getAttribute("style")).toContain("min-width: 180px");

    // Flips above when the rows do not fit below.
    Object.defineProperty(panel, "scrollHeight", { value: 300 });
    window.dispatchEvent(new Event("resize"));
    flush();

    expect(panel.getAttribute("style")).toContain("top: auto");
    expect(panel.getAttribute("style")).toContain("bottom: 304px");
    expect(panel.getAttribute("style")).toContain("max-height: 488px");
  });

  test("clicking the spine toggles the disclosure", () => {
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

  // Browsers fire `history.back()`'s `popstate` in a later task; happy-dom fires it inline.
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

  function phone(): { readonly restore: () => void } {
    const real = globalThis.matchMedia.bind(globalThis);
    globalThis.matchMedia = ((query: string) =>
      query.includes("min-width")
        ? { matches: false, addEventListener() {}, removeEventListener() {} }
        : real(query)) as typeof globalThis.matchMedia;
    return {
      restore: () => {
        globalThis.matchMedia = real as typeof globalThis.matchMedia;
      },
    };
  }

  function modal(): HTMLDialogElement {
    const host = mountPoint();
    render(
      () => (
        <Modal
          open
          label="Settings"
          header={<span>Settings</span>}
          onClose={() => {}}
        >
          <p>body</p>
        </Modal>
      ),
      host
    );
    flush();
    return host.querySelector("dialog")!;
  }

  test("a modal on a phone is as tall as the visible viewport", () => {
    const screen = phone();
    const viewport = fakeViewport(800);
    try {
      const sheet = modal();
      expect(sheet.style.height).toBe("800px");

      viewport.resize(420);
      flush();
      expect(sheet.style.height).toBe("420px");
    } finally {
      viewport.restore();
      screen.restore();
    }
  });

  test("a modal on a desktop takes its height from its content", () => {
    window.innerWidth = 1024;
    const viewport = fakeViewport(800);
    try {
      expect(modal().style.height).toBe("");
    } finally {
      viewport.restore();
    }
  });

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
            <ImageLightbox
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
        <ImageLightbox
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

  function stage(dialog: HTMLDialogElement): HTMLElement {
    return dialog.querySelector<HTMLElement>("[data-stage]")!;
  }

  function pointer(
    target: Element,
    type: string,
    at: { readonly x: number; readonly y: number }
  ): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: at.x,
        clientY: at.y,
      })
    );
  }

  test("the backdrop closes it, the picture does not", () => {
    const { dialog, closed } = lightbox();
    expect(dialog.open).toBe(true);

    dialog.querySelector("img")!.click();
    flush();
    expect(dialog.open).toBe(true);

    stage(dialog).click();
    flush();
    expect(dialog.open).toBe(false);
    expect(closed).toEqual([1]);
  });

  test("a click on the picture stays open once capture retargets it to the backdrop", () => {
    const { dialog, closed } = lightbox();
    const backdrop = stage(dialog);

    pointer(dialog.querySelector("img")!, "pointerdown", { x: 50, y: 50 });
    pointer(backdrop, "pointerup", { x: 50, y: 50 });
    backdrop.click();
    flush();

    expect(dialog.open).toBe(true);
    expect(closed).toEqual([]);
  });

  test("a drag that ends on the backdrop pans rather than closing", () => {
    const { dialog, closed } = lightbox();
    const backdrop = stage(dialog);

    pointer(backdrop, "pointerdown", { x: 10, y: 10 });
    pointer(backdrop, "pointermove", { x: 80, y: 40 });
    pointer(backdrop, "pointerup", { x: 80, y: 40 });
    backdrop.click();
    flush();

    expect(dialog.open).toBe(true);
    expect(closed).toEqual([]);
  });

  test("the file is one control away, and closing is the other", () => {
    const { dialog, closed } = lightbox();

    const download = dialog.querySelector("a")!;
    expect(download.getAttribute("href")).toBe("/files/shot.png");
    expect(download.hasAttribute("download")).toBe(true);
    expect(download.getAttribute("aria-label")).toBe("Download shot.png");

    dialog.querySelector("button")!.click();
    flush();
    expect(dialog.open).toBe(false);
    expect(closed).toEqual([1]);
  });

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

  /** A closed popover keeps its list mounted. */
  function options(host: HTMLElement): readonly Element[] {
    const panel = host.querySelector("[popover]");
    if (panel === null || panel.className.includes("hidden")) {
      return [];
    }
    return [...panel.querySelectorAll('[role="option"]')];
  }

  /** pointerdown then click; false if the click was prevented. */
  function press(target: Element): boolean {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flush();
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    target.dispatchEvent(click);
    flush();
    return !click.defaultPrevented;
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

  test("the press that closes it is not also a press on what it landed on", () => {
    const host = mountPoint();
    const taps: string[] = [];
    render(
      () => (
        <>
          <Menu
            label="claude/opus-5"
            icon="i-griddy-icons:robot"
            options={[{ value: "claude/opus-5", label: "Opus 5" }]}
            onSelect={() => {}}
          />
          <button
            type="button"
            onClick={() => {
              taps.push("elsewhere");
            }}
          >
            Elsewhere
          </button>
        </>
      ),
      host
    );
    flush();

    const chip = host.querySelector("button")!;
    const elsewhere = [...host.querySelectorAll("button")].at(-1)!;
    chip.click();
    flush();
    expect(options(host)).toHaveLength(1);

    expect(press(elsewhere)).toBe(false);
    expect(options(host)).toHaveLength(0);
    expect(taps).toEqual([]);

    expect(press(elsewhere)).toBe(true);
    expect(taps).toEqual(["elsewhere"]);
  });

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

    chip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
    );
    flush();
    expect(options(host)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(ticked()).toEqual([true, false]);
  });

  test("a searchable menu filters its rows and chooses from what is left", async () => {
    const { host, chosen } = paint("Search models");
    host.querySelector("button")!.click();
    flush();

    const field = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    // Focus lands a microtask after the open.
    await Promise.resolve();
    expect(document.activeElement).toBe(field);

    field.value = "gpt";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(options(host).map((row) => row.textContent)).toEqual(["GPT-6"]);

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    flush();
    expect(chosen).toEqual(["openai/gpt-6"]);
    expect(document.activeElement).toBe(host.querySelector("button"));

    host.querySelector("button")!.click();
    flush();
    expect(options(host)).toHaveLength(2);
    expect(
      host.querySelector<HTMLInputElement>('input[type="text"]')!.value
    ).toBe("");
  });

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

describe("bottom-origin scrollers", () => {
  function bind(): {
    readonly pin: BottomPin;
    readonly scroller: HTMLElement;
    readonly dispose: () => void;
  } {
    return createRoot((dispose) => {
      const pin = createBottomPin();
      const scroller = document.createElement("div");
      pin.ref(scroller);
      return { pin, scroller, dispose };
    });
  }

  function scroll(element: HTMLElement, top: number): void {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
    flush();
  }

  test("a fresh scroller follows, and reading back hands the position over", () => {
    const { pin, scroller, dispose } = bind();
    expect(pin.pinned()).toBe(true);

    scroll(scroller, -120);
    expect(pin.pinned()).toBe(false);

    scroll(scroller, -8);
    expect(pin.pinned()).toBe(true);

    dispose();
  });

  test("jumping, and a scroller mounted in its place, both follow again", async () => {
    const { pin, scroller, dispose } = bind();

    scroll(scroller, -400);
    pin.jump();
    flush();
    expect(scroller.scrollTop).toBe(0);
    expect(pin.pinned()).toBe(true);

    scroll(scroller, -400);
    pin.ref(document.createElement("div"));
    await Promise.resolve();
    flush();
    expect(pin.pinned()).toBe(true);

    dispose();
  });

  test("a disposed scroller stops reporting", () => {
    const { pin, scroller, dispose } = bind();
    dispose();

    scroll(scroller, -400);
    expect(pin.pinned()).toBe(true);
  });
});
