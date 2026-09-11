import { expect, test } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createCommandPickerProviderFactory } from "./index";

const commands: AutocompleteProvider = {
  async getSuggestions(lines, _cursorLine, cursorCol) {
    if (!(lines[0] ?? "").slice(0, cursorCol).startsWith("/")) {
      return null;
    }
    return {
      items: [
        { value: "skill:simplify", label: "/skill:simplify" },
        { value: "compact", label: "/compact" },
      ],
      prefix: "/",
    };
  },

  applyCompletion(lines, cursorLine, cursorCol) {
    return { lines, cursorLine, cursorCol };
  },
};

const options = (): { readonly signal: AbortSignal } => ({
  signal: new AbortController().signal,
});

const provider = (): AutocompleteProvider =>
  createCommandPickerProviderFactory()(commands);

test("ranks commands for a slash anywhere on the line", async () => {
  const picker = provider();

  const opening = await picker.getSuggestions(["/simp"], 0, 5, options());
  expect(opening?.items.map((item) => item.label)).toEqual(["/skill:simplify"]);

  const middle = await picker.getSuggestions(["now /simp"], 0, 9, options());
  expect(middle?.items.map((item) => item.label)).toEqual(["/skill:simplify"]);
  expect(middle?.prefix).toBe("/simp");

  expect(await picker.getSuggestions(["src/simp"], 0, 8, options())).toBeNull();
  expect(await picker.getSuggestions(["/nope"], 0, 5, options())).toBeNull();
});

test("completes a mid-line command in place, with one trailing space", async () => {
  const picker = provider();
  const lines = ["now /simp please"];
  const answer = await picker.getSuggestions(lines, 0, 9, options());

  expect(
    picker.applyCompletion(lines, 0, 9, answer!.items[0]!, answer!.prefix)
  ).toEqual({
    lines: ["now /skill:simplify please"],
    cursorLine: 0,
    cursorCol: 19,
  });
});

test("leaves a completion it did not answer with to pi", async () => {
  const picker = provider();
  const lines = ["/home/ht"];

  expect(
    picker.applyCompletion(
      lines,
      0,
      8,
      { value: "/home/htpc/", label: "/home/htpc/" },
      "/home/ht"
    )
  ).toEqual({ lines, cursorLine: 0, cursorCol: 8 });
});
