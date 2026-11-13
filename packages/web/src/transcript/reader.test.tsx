import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { createReader, type Reader } from "./reader";

const VIEWPORT = 600;
const INSET = 100;

type Block = {
  readonly attrs: Readonly<Record<string, string>>;
  y: number;
  height: number;
};

let observers: (() => void)[] = [];
let frames: FrameRequestCallback[] = [];
const RealObserver = globalThis.ResizeObserver;
const realFrame = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;

beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
    }
    observe(): void {
      observers.push(this.#callback);
    }
    unobserve(): void {}
    disconnect(): void {
      observers = observers.filter((one) => one !== this.#callback);
    }
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {
    frames = [];
  };
});

afterEach(() => {
  globalThis.ResizeObserver = RealObserver;
  globalThis.requestAnimationFrame = realFrame;
  globalThis.cancelAnimationFrame = realCancel;
});

function layout(): void {
  for (const observer of observers) {
    observer();
  }
  flush();
}

function rect(top: number, height = 0): DOMRect {
  return { top, height } as DOMRect;
}

// Document coordinates; `scrollTop` 0 shows the last `VIEWPORT` px.
function mount(blocks: Block[], height: number) {
  const page = { height };
  let reader!: Reader;
  const host = mountPoint();
  render(() => {
    reader = createReader(() => INSET);
    return (
      <div ref={reader.ref}>
        <div ref={reader.content} />
      </div>
    );
  }, host);
  const scroller = host.firstElementChild as HTMLElement;
  const content = scroller.firstElementChild as HTMLElement;
  const viewTop = (): number => page.height - VIEWPORT + scroller.scrollTop;
  Object.defineProperty(scroller, "clientHeight", { get: () => VIEWPORT });
  Object.defineProperty(scroller, "scrollHeight", { get: () => page.height });
  scroller.getBoundingClientRect = () => rect(0, VIEWPORT);

  const add = (block: Block): void => {
    const element = document.createElement("div");
    for (const [name, value] of Object.entries(block.attrs)) {
      element.setAttribute(name, value);
    }
    Object.defineProperty(element, "offsetHeight", {
      get: () => block.height,
    });
    element.getBoundingClientRect = () =>
      rect(block.y - viewTop(), block.height);
    content.append(element);
  };
  for (const block of blocks) {
    add(block);
  }
  flush();

  return {
    reader,
    page,
    add,
    viewTop,
    scroller,
    /** Runs the glide's frames to its end. */
    finish(): void {
      while (frames.length > 0) {
        const due = frames;
        frames = [];
        for (const frame of due) {
          frame(performance.now() + 60_000);
        }
      }
      scroller.dispatchEvent(new Event("scroll"));
      flush();
    },
    scrollTo(top: number): void {
      scroller.scrollTop = top - (page.height - VIEWPORT);
      scroller.dispatchEvent(new Event("scroll"));
      flush();
    },
    get scrollTop(): number {
      return scroller.scrollTop;
    },
  };
}

const prompt = (y: number): Block => ({
  attrs: { "data-stop": "" },
  y,
  height: 60,
});
const reply = (id: string, y: number, height: number): Block => ({
  attrs: { "data-reply": id },
  y,
  height,
});
const answer = (id: string, y: number, height: number): Block => ({
  attrs: { "data-reply": id, "data-stop": "" },
  y,
  height,
});

// The landing line is 12px under the top edge.
function session() {
  return mount(
    [
      prompt(100),
      answer("a1", 300, 800),
      prompt(1200),
      reply("narration", 1400, 50),
      answer("a2", 1600, 1300),
    ],
    3000
  );
}

describe("stepping between stops", () => {
  test("up from the bottom walks back through answers and prompts, skipping narration", () => {
    const view = session();
    layout();

    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(1600 - 12);
    expect(view.reader.pinned()).toBe(false);

    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(1200 - 12);
  });

  test("halfway through an answer, up goes to that answer's start", () => {
    const view = session();
    view.scrollTo(700);

    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(300 - 12);
  });

  test("down steps to the next stop, then past the last one to the bottom", () => {
    const view = session();
    view.scrollTo(700);

    view.reader.down();
    view.finish();
    expect(view.viewTop()).toBe(1200 - 12);
    view.reader.down();
    view.finish();
    expect(view.viewTop()).toBe(1600 - 12);
    view.reader.down();
    view.finish();
    expect(view.scrollTop).toBe(0);
    expect(view.reader.pinned()).toBe(true);
  });

  test("a press mid-glide steps on from where the glide is heading", () => {
    const view = session();
    layout();

    view.reader.up();
    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(1200 - 12);
  });

  test("scrolling by hand mid-glide stops it where it is, and the next step counts from there", () => {
    const view = session();
    layout();
    view.reader.up();
    view.scroller.dispatchEvent(new Event("wheel"));
    view.finish();
    expect(view.scrollTop).toBe(0);

    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(1600 - 12);
  });

  test("with reduced motion, a step lands at once without gliding", () => {
    const view = session();
    layout();
    const real = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    })) as typeof globalThis.matchMedia;
    try {
      view.reader.up();
    } finally {
      globalThis.matchMedia = real;
    }
    expect(frames).toEqual([]);
    expect(view.viewTop()).toBe(1600 - 12);
  });

  test("up above the first stop goes to the very top", () => {
    const view = session();
    view.scrollTo(50);

    view.reader.up();
    view.finish();
    expect(view.viewTop()).toBe(0);
  });
});

describe("following a reply as it streams", () => {
  test("a reply that fits keeps following; one that outgrows the view holds at its start", () => {
    const view = session();
    layout();
    const streaming = reply("a3", 3000, 200);
    view.add(streaming);
    view.page.height = 3200;
    layout();
    expect(view.scrollTop).toBe(0);
    expect(view.reader.pinned()).toBe(true);

    streaming.height = 700;
    view.page.height = 3700;
    layout();
    expect(view.viewTop()).toBe(3000 - 12);
    expect(view.reader.pinned()).toBe(false);

    streaming.height = 1000;
    view.page.height = 4000;
    layout();
    expect(view.scrollTop).toBe(-112);
  });

  test("back at the bottom, the reply already read from its start is followed, not held again", () => {
    const view = session();
    layout();
    const streaming = reply("a3", 3000, 700);
    view.add(streaming);
    view.page.height = 3700;
    layout();
    expect(view.reader.pinned()).toBe(false);

    view.scrollTo(3700 - VIEWPORT);
    expect(view.reader.pinned()).toBe(true);
    streaming.height = 1000;
    view.page.height = 4000;
    layout();
    expect(view.scrollTop).toBe(0);
  });

  test("a long reply already on screen when following resumes is not jumped back to", () => {
    const view = session();
    layout();
    view.scrollTo(700);
    view.scrollTo(3000 - VIEWPORT);
    view.page.height = 3100;
    view.add(prompt(3000));
    layout();
    expect(view.scrollTop).toBe(0);
  });
});

describe("opening a session", () => {
  test("read, it stays at the bottom", () => {
    const view = session();
    view.reader.open(false);
    layout();
    expect(view.scrollTop).toBe(0);
  });

  test("unread, it lands on the start of the last reply", () => {
    const view = session();
    view.reader.open(true);
    layout();
    expect(view.viewTop()).toBe(1600 - 12);
    expect(view.reader.pinned()).toBe(false);
  });
});
