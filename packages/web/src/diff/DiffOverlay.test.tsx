import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flush } from "solid-js";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import type { ChangeList, FileDiff } from "#protocol/Diff";
import type { CommandDraft } from "#protocol/Command";
import type { ResponseEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness, until } from "../test/gateway";
import { Topbar } from "../topbar/Topbar";
import { DiffOverlay } from "./DiffOverlay";

/**
 * The change set of a real repository, read over the real gateway: the rows are
 * what git says about files this test wrote, and expanding one runs the diff.
 */

let harness: GatewayHarness;
let store: SessionStore;
let repo: string;
let dispose: (() => void) | undefined;
let sent: CommandDraft[];

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  repo = join(harness.tmp, "repo");
  await mkdir(repo, { recursive: true });
  await makeRepo(repo);
  store = new SessionStore({
    url: harness.url,
    cwd: repo,
    pickerDebounceMs: 0,
  });
  await store.connect();
  await until(() => store.state.branch !== undefined, "the branch to land");
  sent = [];
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  store.dispose();
  await harness.stop();
  mock.restore();
});

/** Two tracked files, both committed and then edited. */
async function seed(): Promise<void> {
  await Bun.write(join(repo, "alpha.ts"), "one\ntwo\nthree\n");
  await Bun.write(join(repo, "src/beta.ts"), "alpha\nbeta\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "seed"]);
  await Bun.write(join(repo, "alpha.ts"), "one\ntwo\nTHREE\n");
  await Bun.write(join(repo, "src/beta.ts"), "alpha\nBETA\n");
}

/** Every command the overlay asks for, with an optional stand-in answer. */
function watch(answer?: (command: CommandDraft) => ResponseEvent | undefined) {
  const original = store.client.send.bind(store.client);
  spyOn(store.client, "send").mockImplementation((command: CommandDraft) => {
    sent.push(command);
    const stub = answer?.(command);
    return stub === undefined ? original(command) : Promise.resolve(stub);
  });
}

function asked(type: CommandDraft["type"]): readonly CommandDraft[] {
  return sent.filter((command) => command.type === type);
}

function paint(): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => <DiffOverlay open={true} store={store} onClose={() => {}} />,
    host
  );
  flush();
  return host;
}

function rows(host: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ].filter((button) => button.getAttribute("aria-haspopup") === null);
}

function labels(host: HTMLElement): readonly string[] {
  return rows(host).map((row) => row.getAttribute("aria-label") ?? "");
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

/** A change list no repository has to be built for: the row ceiling needs more files than git can cheaply make. */
function bulk(files: number): ChangeList {
  return {
    base: { kind: "worktree" },
    files: Array.from({ length: files }, (_, at) => ({
      path: `src/file-${at}.ts`,
      status: "modified" as const,
      added: 1,
      removed: 0,
      fingerprint: `f${at}`,
    })),
    added: files,
    removed: 0,
    truncated: true,
  };
}

function answerWith(changes?: ChangeList, fileDiff?: FileDiff): void {
  watch((command) => {
    if (command.type === "list_changes" && changes !== undefined) {
      return { type: "response", id: "stub", success: true, changes };
    }
    if (command.type === "file_diff" && fileDiff !== undefined) {
      return { type: "response", id: "stub", success: true, fileDiff };
    }
    return undefined;
  });
}

function clickText(host: HTMLElement, label: string): void {
  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === label)
    ?.click();
}

/** The state frame the server sends whenever the repository moves. */
function dirty(count: number): void {
  store.ingest({
    type: "session_state",
    writable: true,
    cwd: repo,
    model: "test/echo",
    thinking: "off",
    cost: 0,
    status: "idle",
    branch: "main",
    dirtyCount: count,
    ahead: 0,
    behind: 0,
  });
}

/** The overlay painted with its first list already landed. */
async function open(): Promise<HTMLElement> {
  watch();
  const host = paint();
  await settle(() => asked("list_changes").length > 0, "the change list");
  return host;
}

test("the list is every file the base says changed", async () => {
  await seed();
  const host = await open();

  await settle(() => rows(host).length === 2, "both rows");
  expect(labels(host)).toEqual(["alpha.ts", "src/beta.ts"]);
  expect(host.textContent).toContain("2 files");
  expect(host.textContent).toContain("+2");
  expect(host.textContent).toContain("−2");
});

test("expanding reads the file once, and never again", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();
  await settle(() => host.textContent?.includes("THREE") === true, "the hunks");
  expect(asked("file_diff").length).toBe(1);

  rows(host)[0]?.click();
  flush();
  rows(host)[0]?.click();
  await settle(() => host.textContent?.includes("THREE") === true, "the hunks");
  expect(asked("file_diff").length).toBe(1);
});

test("two files expanded at once both arrive", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();
  rows(host)[1]?.click();

  await settle(
    () =>
      host.textContent?.includes("THREE") === true &&
      host.textContent.includes("BETA"),
    "both diffs"
  );
  expect(asked("file_diff").length).toBe(2);
  expect(host.querySelector("p.text-rose-400")).toBeNull();
});

test("changing the base reads the list again and forgets the hunks", async () => {
  await seed();
  await git(repo, ["add", "alpha.ts"]);
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();
  await settle(() => asked("file_diff").length === 1, "the first diff");

  host.querySelector<HTMLButtonElement>("[aria-haspopup='listbox']")?.click();
  flush();
  [...host.querySelectorAll<HTMLElement>("[role='option']")]
    .find((option) => option.textContent?.includes("index vs HEAD"))
    ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  await settle(() => rows(host).length === 1, "the staged list");
  expect(asked("list_changes").length).toBe(2);
  expect(labels(host)).toEqual(["alpha.ts"]);

  rows(host)[0]?.click();
  await settle(
    () => host.textContent?.includes("THREE") === true,
    "the re-read diff"
  );
  expect(asked("file_diff").length).toBe(2);
});

test("a refused diff is an error row inside its file", async () => {
  await seed();
  watch((command) =>
    command.type === "file_diff"
      ? {
          type: "response",
          id: "stub",
          success: false,
          error: "git refused to read it",
        }
      : undefined
  );
  const host = paint();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();

  await settle(
    () => host.textContent?.includes("git refused to read it") === true,
    "the error row"
  );
  expect(rows(host).length).toBe(2);
});

test("a clean tree says so", async () => {
  const host = await open();

  await settle(
    () => host.textContent?.includes("Nothing has changed.") === true,
    "the empty state"
  );
  expect(rows(host)).toEqual([]);
});

test("the Diff button opens the overlay while an agent is working", async () => {
  await seed();
  const host = mountPoint();
  dispose = render(
    () => <Topbar store={store} compact={false} onToggleSidebar={() => {}} />,
    host
  );
  flush();
  store.ingest({
    type: "session_state",
    writable: true,
    repoBusy: true,
    cwd: repo,
    model: "test/echo",
    thinking: "off",
    cost: 0,
    status: "thinking",
    branch: "main",
    dirtyCount: 2,
    ahead: 0,
    behind: 0,
  });
  flush();

  host.querySelector<HTMLButtonElement>("[aria-haspopup='listbox']")?.click();
  flush();
  const diff = host.querySelector<HTMLButtonElement>(
    "[title='Read what has changed']"
  );
  expect(diff?.disabled).toBe(false);

  diff?.click();
  await settle(() => rows(host).length === 2, "the overlay's rows");
  expect(
    host.querySelector<HTMLDialogElement>("[aria-label='Changes']")?.open
  ).toBe(true);
});

test("the list paints five hundred rows, and the next five hundred on request", async () => {
  answerWith(bulk(1200));
  const host = paint();

  await settle(() => rows(host).length === 500, "the first page");
  expect(host.textContent).toContain("500 of 1200");
  expect(host.textContent).toContain("More files changed than this list holds");

  clickText(host, "show more");

  await settle(() => rows(host).length === 1000, "the second page");
  expect(host.textContent).toContain("1000 of 1200");
});

test("a repository that moves marks the list stale and waits to be asked", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  dirty(99);
  flush();

  expect(host.textContent).toContain("The repository has changed");
  expect(asked("list_changes").length).toBe(1);

  host
    .querySelector<HTMLButtonElement>("[title='Read the change list again']")
    ?.click();

  await settle(() => asked("list_changes").length === 2, "the re-read");
  expect(host.querySelector("[title='Read the change list again']")).toBeNull();
});

test("a diff too large to paint says so, and offers no way past it", async () => {
  await seed();
  answerWith(undefined, {
    path: "alpha.ts",
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [{ kind: "added", newLine: 1, text: "the part that fit" }],
      },
    ],
    truncated: true,
  });
  const host = paint();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();

  await settle(
    () => host.textContent?.includes("diff is very large") === true,
    "the note"
  );
  expect(host.textContent).toContain("the part that fit");
  expect(host.textContent).not.toContain("no textual changes");
  expect(
    [...host.querySelectorAll("button")].some((button) =>
      /show anyway/i.test(button.textContent ?? "")
    )
  ).toBe(false);
});

test("a binary file reads as one row and the size of each side", async () => {
  await seed();
  answerWith(undefined, {
    path: "alpha.ts",
    hunks: [],
    binary: true,
    oldBytes: 1200,
    newBytes: 3400,
  });
  const host = paint();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();

  await settle(
    () => host.textContent?.includes("binary file") === true,
    "the binary row"
  );
  expect(host.textContent).toContain("1.2 kB → 3.4 kB");
  expect(host.querySelector("img")).toBeNull();
});
