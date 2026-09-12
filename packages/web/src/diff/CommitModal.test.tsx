import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import { CommitModal } from "./CommitModal";

/** The modal alone: what it arrives holding, and what it hands back. */

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

type Opened = {
  readonly host: HTMLElement;
  /** Every pathspec the modal handed back, one entry per commit. */
  readonly committed: readonly (readonly string[])[];
  readonly closes: () => number;
};

function paint(
  files: readonly ChangeSummary[],
  extra: {
    readonly committing?: boolean;
    readonly failure?: string;
  } = {}
): Opened {
  const host = mountPoint();
  const [message, setMessage] = createSignal("");
  const committed: (readonly string[])[] = [];
  let closes = 0;
  dispose = render(
    () => (
      <CommitModal
        open={true}
        files={files}
        message={message()}
        committing={extra.committing === true}
        failure={extra.failure}
        onClose={() => {
          closes += 1;
        }}
        onMessage={setMessage}
        onCommit={(paths) => committed.push(paths)}
      />
    ),
    host
  );
  flush();
  return { host, committed, closes: () => closes };
}

function button(host: HTMLElement): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim().startsWith("Commit")
  ) as HTMLButtonElement;
}

function all(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    "[aria-label='Pick every file'], [aria-label='Clear every pick']"
  )!;
}

/** The row that heads the list, which is the one the select-all sits on. */
function summary(host: HTMLElement): HTMLElement {
  return all(host).parentElement as HTMLElement;
}

function row(host: HTMLElement, path: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `[role='checkbox'][aria-label='${path}']`
  )!;
}

function field(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector("textarea") as HTMLTextAreaElement;
}

function type(opened: Opened, text: string): void {
  const box = field(opened.host);
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

test("opening picks every file", () => {
  const { host } = paint([file("alpha.ts", 420, 0), file("beta.ts", 12, 3)]);

  expect(row(host, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  expect(row(host, "beta.ts").getAttribute("aria-checked")).toBe("true");
  expect(all(host).getAttribute("aria-label")).toBe("Clear every pick");
  expect(summary(host).textContent).toContain("2 files");
  expect(summary(host).textContent).toContain("+432/−3");
  expect(document.activeElement).toBe(field(host));
});

/** A row dropped from the commit dims rather than vanishing, so the stat over
    the list reads as a subtraction from what is still there. */
test("unpicking a file leaves the list and takes the stat with it", () => {
  const { host } = paint([file("alpha.ts", 420, 0), file("beta.ts", 12, 3)]);

  row(host, "alpha.ts").click();
  flush();

  expect(row(host, "alpha.ts").getAttribute("aria-checked")).toBe("false");
  expect(row(host, "alpha.ts").innerHTML).toContain("opacity-40");
  expect(all(host).getAttribute("aria-label")).toBe("Pick every file");
  expect(summary(host).textContent).toContain("+12/−3");
});

test("nothing picked is nothing to commit, whatever is typed", () => {
  const opened = paint([file("alpha.ts", 1, 0)]);
  type(opened, "the reviewed change");
  expect(button(opened.host).disabled).toBe(false);

  all(opened.host).click();
  flush();
  expect(button(opened.host).disabled).toBe(true);
  expect(summary(opened.host).textContent).not.toContain("+1");
});

test("a message of nothing but space leaves Commit disabled", () => {
  const opened = paint([file("alpha.ts", 1, 0)]);
  expect(button(opened.host).disabled).toBe(true);

  type(opened, "   ");
  expect(button(opened.host).disabled).toBe(true);

  type(opened, "the reviewed change");
  expect(button(opened.host).disabled).toBe(false);
});

test("a rename is committed by both of its names, in list order", () => {
  const opened = paint([
    file("src/gamma.ts", 1, 1, "src/beta.ts"),
    file("alpha.ts", 2, 0),
  ]);
  type(opened, "renamed");

  button(opened.host).click();

  expect(opened.committed).toEqual([
    ["src/gamma.ts", "src/beta.ts", "alpha.ts"],
  ]);
});

test("only the picked files go on the pathspec", () => {
  const opened = paint([file("alpha.ts", 1, 0), file("beta.ts", 2, 0)]);
  row(opened.host, "beta.ts").click();
  type(opened, "half a tree");

  button(opened.host).click();

  expect(opened.committed).toEqual([["alpha.ts"]]);
});

test("the message box commits on ctrl+enter", () => {
  const opened = paint([file("alpha.ts", 1, 0)]);
  type(opened, "the reviewed change");

  field(opened.host).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
  );
  flush();

  expect(opened.committed).toEqual([["alpha.ts"]]);
});

test("a commit under way spins and refuses a second click", () => {
  const opened = paint([file("alpha.ts", 1, 0)], { committing: true });
  type(opened, "the reviewed change");

  expect(button(opened.host).disabled).toBe(true);
  expect(opened.host.querySelector(".animate-spin")).not.toBeNull();

  button(opened.host).click();
  expect(opened.committed).toEqual([]);
});

test("a refusal is read in the modal, over the message that was refused", () => {
  const opened = paint([file("alpha.ts", 1, 0)], {
    failure: "the agent is working in this repository",
  });
  type(opened, "the reviewed change");

  expect(opened.host.textContent).toContain("the agent is working");
  expect(opened.host.querySelector("dialog")?.open).toBe(true);
  expect(field(opened.host).value).toBe("the reviewed change");
  expect(opened.closes()).toBe(0);
});
