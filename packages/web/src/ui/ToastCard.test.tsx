import "../test/dom";

import { render } from "@solidjs/web";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { ToastCard } from "./ToastCard";

let dispose: (() => void) | undefined;
let host: HTMLElement;
let now = 0;

beforeEach(() => {
  now = 0;
  jest.useFakeTimers();
  spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  flush();
  host?.remove();
  mock.restore();
  jest.useRealTimers();
});

function advance(ms: number): void {
  now += ms;
  jest.advanceTimersByTime(ms);
  flush();
}

function paint(dismissMs?: number) {
  host = mountPoint();
  const dismiss = mock(() => {});
  dispose = render(
    () => (
      <ToastCard
        dismissLabel="Dismiss notification"
        dismissMs={dismissMs}
        onDismiss={dismiss}
      >
        Saved <a href="#details">Details</a>
      </ToastCard>
    ),
    host
  );
  flush();
  const card = host.querySelector<HTMLDivElement>('[role="status"]')!;
  const button = card.querySelector("button")!;
  return { card, button, dismiss };
}

function pointer(
  target: HTMLElement,
  type: string,
  x = 0,
  y = 0,
  options: PointerEventInit = {}
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    button: 0,
    clientX: x,
    clientY: y,
    ...options,
  });
  target.dispatchEvent(event);
  flush();
  return event;
}

function focus(
  target: HTMLElement,
  type: string,
  relatedTarget: EventTarget | null = null
): void {
  target.dispatchEvent(new FocusEvent(type, { bubbles: true, relatedTarget }));
  flush();
}

describe("ToastCard", () => {
  test("the labelled native close button accepts non-pointer activation", () => {
    const { button, dismiss } = paint();
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Dismiss notification");
    button.focus();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    flush();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("horizontal touch gestures are left to the shell", () => {
    const { card, dismiss } = paint();
    pointer(card, "pointerdown");
    expect(pointer(card, "pointermove", 150).defaultPrevented).toBe(false);
    pointer(card, "pointerup", 150);
    expect(card.style.transform).toBe("");
    expect(card.style.touchAction).toBe("");
    advance(1000);
    expect(dismiss).not.toHaveBeenCalled();
  });

  test("an untouched timer dismisses exactly at its deadline", () => {
    const { dismiss } = paint(1000);
    advance(999);
    expect(dismiss).not.toHaveBeenCalled();
    advance(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("hover and focus both have to leave before the remaining timer resumes", () => {
    const { card, button, dismiss } = paint(1000);
    advance(250);
    pointer(card, "pointerenter", 0, 0, { pointerType: "mouse" });
    advance(2000);
    focus(button, "focusin");
    pointer(card, "pointerleave", 0, 0, { pointerType: "mouse" });
    advance(2000);
    expect(dismiss).not.toHaveBeenCalled();
    focus(button, "focusout");
    advance(749);
    expect(dismiss).not.toHaveBeenCalled();
    advance(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("moving focus within the card does not resume the timer", () => {
    const { card, button, dismiss } = paint(1000);
    advance(250);
    focus(button, "focusin");
    const link = card.querySelector("a")!;
    focus(button, "focusout", link);
    focus(link, "focusin", button);
    advance(2000);
    expect(dismiss).not.toHaveBeenCalled();
    focus(link, "focusout");
    advance(750);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("touch entry does not pause the timer", () => {
    const { card, dismiss } = paint(1000);
    advance(250);
    pointer(card, "pointerenter");
    advance(750);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("unmount clears the dismissal timer", () => {
    const { dismiss } = paint(1000);
    dispose!();
    dispose = undefined;
    advance(2000);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
