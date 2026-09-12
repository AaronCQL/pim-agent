import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import { CommitCard } from "./CommitCard";

/** The card alone: what it says about the picks, and what it hands back. */

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function file(
  path: string,
  added: number,
  removed: number,
  oldPath?: string
): ChangeSummary {
  return {
    path,
    status: oldPath === undefined ? "modified" : "renamed",
    added,
    removed,
    fingerprint: `${path}:${added}`,
    ...(oldPath === undefined ? {} : { oldPath }),
  };
}

type Card = {
  readonly host: HTMLElement;
  /** Every pathspec the card handed back, one entry per click. */
  readonly committed: readonly (readonly string[])[];
};

function paint(
  files: readonly ChangeSummary[],
  extra: {
    readonly committing?: boolean;
    readonly failure?: string;
    readonly committed?: string;
  } = {}
): Card {
  const host = mountPoint();
  const [message, setMessage] = createSignal("");
  const committed: (readonly string[])[] = [];
  dispose = render(
    () => (
      <CommitCard
        files={files}
        message={message()}
        committing={extra.committing === true}
        failure={extra.failure}
        committed={extra.committed}
        onMessage={setMessage}
        onCommit={(paths) => committed.push(paths)}
      />
    ),
    host
  );
  flush();
  return { host, committed };
}

function button(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;
}

function type(card: Card, text: string): void {
  const box = card.host.querySelector("textarea") as HTMLTextAreaElement;
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

test("the card counts the picked files and sums their stat", () => {
  const { host } = paint([file("alpha.ts", 420, 0), file("beta.ts", 12, 3)]);

  expect(host.textContent).toContain("Commit 2 files");
  expect(host.textContent).toContain("+432");
  expect(host.textContent).toContain("−3");
});

test("one file is a file, not files", () => {
  const { host } = paint([file("alpha.ts", 1, 0)]);

  expect(host.textContent).toContain("Commit 1 file");
  expect(host.textContent).not.toContain("1 files");
});

test("a message of nothing but space leaves Commit disabled", () => {
  const card = paint([file("alpha.ts", 1, 0)]);
  expect(button(card.host).disabled).toBe(true);

  type(card, "   ");
  expect(button(card.host).disabled).toBe(true);

  type(card, "the reviewed change");
  expect(button(card.host).disabled).toBe(false);
});

test("a rename is committed by both of its names, in list order", () => {
  const card = paint([
    file("src/gamma.ts", 1, 1, "src/beta.ts"),
    file("alpha.ts", 2, 0),
  ]);
  type(card, "renamed");

  button(card.host).click();

  expect(card.committed).toEqual([["src/gamma.ts", "src/beta.ts", "alpha.ts"]]);
});

test("a commit under way spins and refuses a second click", () => {
  const card = paint([file("alpha.ts", 1, 0)], { committing: true });
  type(card, "the reviewed change");

  expect(button(card.host).disabled).toBe(true);
  expect(card.host.querySelector(".animate-spin")).not.toBeNull();

  button(card.host).click();
  expect(card.committed).toEqual([]);
});

test("a refusal is read in the card, over the message that was refused", () => {
  const card = paint([file("alpha.ts", 1, 0)], {
    failure: "the agent is working in this repository",
  });
  type(card, "the reviewed change");

  expect(card.host.textContent).toContain("the agent is working");
  expect(card.host.querySelector("textarea")?.value).toBe(
    "the reviewed change"
  );
});

test("a receipt outlives the picks it was written from", () => {
  const { host } = paint([], { committed: "a1b2c3d" });

  expect(host.textContent).toContain("committed a1b2c3d");
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
});
