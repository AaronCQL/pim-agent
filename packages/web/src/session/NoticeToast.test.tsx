import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, describe, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import { until } from "#core/shared/fixtures/wait";
import { mountPoint } from "../test/dom";
import { NoticeToast } from "./NoticeToast";
import type { UiNotice } from "./SessionStore";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  flush();
});

type Painted = {
  readonly host: HTMLElement;
  readonly dismissed: readonly string[];
  readonly show: (notices: readonly UiNotice[]) => void;
};

function paint(
  initial: readonly UiNotice[],
  dismissMs = 10_000,
  desktop = true
): Painted {
  const [notices, setNotices] = createSignal(initial);
  const dismissed: string[] = [];
  const host = mountPoint();
  dispose = render(
    () => (
      <NoticeToast
        notices={notices()}
        desktop={desktop}
        dismissMs={dismissMs}
        onDismiss={(id) => {
          dismissed.push(id);
          setNotices((held) => held.filter((notice) => notice.id !== id));
        }}
      />
    ),
    host
  );
  flush();
  return {
    host,
    dismissed,
    show: (next) => {
      setNotices(next);
      flush();
    },
  };
}

function toasts(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="status"]')];
}

const WARMED: UiNotice = {
  id: "n1",
  severity: "info",
  text: "The cache finished warming.",
};

const FAILED: UiNotice = {
  id: "n2",
  severity: "error",
  text: "The refresh token expired.",
};

describe("the notice toast", () => {
  test("stacks what arrived, each clamped and wearing its severity", () => {
    const { host } = paint([WARMED, FAILED]);

    expect(toasts(host).map((toast) => toast.textContent)).toEqual([
      WARMED.text,
      FAILED.text,
    ]);
    // A column with a gap: two of them may never land on one another.
    expect(host.firstElementChild?.className).toContain("flex-col");
    expect(host.firstElementChild?.className).toContain("gap-2");
    expect(toasts(host)[1]?.className).toContain("text-rose-400");
    expect(toasts(host)[0]?.lastElementChild?.className).toContain(
      "line-clamp-3"
    );
  });

  test("the dismiss takes that one and leaves the rest", () => {
    const { host, dismissed } = paint([WARMED, FAILED]);

    toasts(host)[0]!.querySelector("button")!.click();
    flush();

    expect(dismissed).toEqual(["n1"]);
    expect(toasts(host).map((toast) => toast.textContent)).toEqual([
      FAILED.text,
    ]);
  });

  test("one nobody touches sees itself out", async () => {
    const { host, dismissed } = paint([WARMED], 0);

    await until(() => {
      flush();
      return toasts(host).length === 0;
    }, "the toast to dismiss itself");
    expect(dismissed).toEqual(["n1"]);
  });

  test("a notice that left before its time is up takes its timer with it", async () => {
    const { host, dismissed, show } = paint([WARMED], 0);
    show([]);

    expect(toasts(host)).toHaveLength(0);
    // Dropped by the store instead — a session switch, another window's
    // dismissal — so the timer that outlived it must say nothing.
    for (let tick = 0; tick < 5; tick += 1) {
      await Bun.sleep(0);
      flush();
    }
    expect(dismissed).toEqual([]);
  });
});
