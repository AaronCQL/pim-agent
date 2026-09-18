import { expect, spyOn, test } from "bun:test";

import type { NoticeSeverity } from "../view/ViewBlock";
import { adaptSessionUi, type SessionUi, type UiAsk } from "./SessionUi";

type Notice = { readonly text: string; readonly severity: NoticeSeverity };

function recorder(): {
  readonly ui: SessionUi;
  readonly notices: Notice[];
  readonly asks: UiAsk[];
} {
  const notices: Notice[] = [];
  const asks: UiAsk[] = [];
  return {
    notices,
    asks,
    ui: {
      notify: (text, severity) => notices.push({ text, severity }),
      select: async (_title, options, opts) => {
        if (opts) {
          asks.push(opts);
        }
        return options[0];
      },
      confirm: async () => true,
      input: async (_title, placeholder) => placeholder,
    },
  };
}

/** Every dialog at once, so a fallback assertion says the same thing three ways. */
async function answers(ui: ReturnType<typeof adaptSessionUi>) {
  return {
    select: await ui.select("pick", ["a", "b"]),
    confirm: await ui.confirm("sure?", "really"),
    input: await ui.input("name", "ada"),
  };
}

test("passes an extension's words to the sink with pi's kinds mapped", () => {
  const { ui, notices } = recorder();
  const adapted = adaptSessionUi(() => ui);

  adapted.notify("plain");
  adapted.notify("careful", "warning");
  adapted.notify("broken", "error");
  adapted.notify("stated", "info");

  expect(notices).toEqual([
    { text: "plain", severity: "info" },
    { text: "careful", severity: "warn" },
    { text: "broken", severity: "error" },
    { text: "stated", severity: "info" },
  ]);
});

test("answers the dialogs from the sink, options and all", async () => {
  const { ui } = recorder();

  expect(await answers(adaptSessionUi(() => ui))).toEqual({
    select: "a",
    confirm: true,
    input: "ada",
  });
});

test("forwards the deadline and the signal an extension asked with", async () => {
  const { ui, asks } = recorder();
  const signal = AbortSignal.abort();

  await adaptSessionUi(() => ui).select("pick", ["a"], {
    timeout: 5_000,
    signal,
  });

  expect(asks).toEqual([{ timeout: 5_000, signal }]);
});

test("takes pi's defaults when no sink is set", async () => {
  const adapted = adaptSessionUi(() => undefined);

  expect(() => adapted.notify("into the void")).not.toThrow();
  expect(await answers(adapted)).toEqual({
    select: undefined,
    confirm: false,
    input: undefined,
  });
});

test("reads the sink late, so a host that gains one mid-session is heard", async () => {
  const { ui, notices } = recorder();
  let sink: SessionUi | undefined;
  const adapted = adaptSessionUi(() => sink);

  adapted.notify("unheard");
  sink = ui;
  adapted.notify("heard");

  expect(notices).toEqual([{ text: "heard", severity: "info" }]);
  expect(await adapted.confirm("sure?", "really")).toBe(true);
});

test("takes pi's defaults when the sink rejects", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const failing: SessionUi = {
    notify: () => {
      throw new Error("gone");
    },
    select: () => Promise.reject(new Error("gone")),
    confirm: () => Promise.reject(new Error("gone")),
    input: () => Promise.reject(new Error("gone")),
  };
  const adapted = adaptSessionUi(() => failing);

  expect(() => adapted.notify("unsayable")).not.toThrow();
  expect(await answers(adapted)).toEqual({
    select: undefined,
    confirm: false,
    input: undefined,
  });
  expect(warn).toHaveBeenCalledTimes(4);
  warn.mockRestore();
});

test("takes pi's defaults when the sink throws before it returns a promise", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const throwing = (): never => {
    throw new Error("gone");
  };
  const adapted = adaptSessionUi(() => ({
    notify: throwing,
    select: throwing,
    confirm: throwing,
    input: throwing,
  }));

  expect(await answers(adapted)).toEqual({
    select: undefined,
    confirm: false,
    input: undefined,
  });
  warn.mockRestore();
});
