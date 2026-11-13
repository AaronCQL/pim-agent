import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { flush } from "solid-js";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { until } from "#core/shared/fixtures/wait";
import type { CommandDraft } from "#protocol/Command";
import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import { GatewayHarness } from "../test/gateway";
import { FileTree } from "./FileTree";

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
  await Bun.write(join(repo, "src/alpha.ts"), "one\ntwo\nthree\n");
  await Bun.write(join(repo, "README.md"), "# readme\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "seed"]);
  await Bun.write(join(repo, "src/alpha.ts"), "one\ntwo\nTHREE\n");
  store = new SessionStore({
    url: harness.url,
    cwd: repo,
    pickerDebounceMs: 0,
  });
  await store.connect();
  await store.refreshGit();
  sent = [];
  const original = store.client.send.bind(store.client);
  spyOn(store.client, "send").mockImplementation((command: CommandDraft) => {
    sent.push(command);
    return original(command);
  });
});

let realMatchMedia: typeof globalThis.matchMedia | undefined;

/** Below `md`, where the tree and the file can't sit side by side. */
function narrow(): void {
  realMatchMedia = globalThis.matchMedia;
  const real = realMatchMedia.bind(globalThis);
  globalThis.matchMedia = ((query: string) =>
    query.includes("min-width")
      ? { matches: false, addEventListener() {}, removeEventListener() {} }
      : real(query)) as typeof globalThis.matchMedia;
}

afterEach(async () => {
  if (realMatchMedia !== undefined) {
    globalThis.matchMedia = realMatchMedia;
    realMatchMedia = undefined;
  }
  dispose?.();
  dispose = undefined;
  store.dispose();
  await harness.stop();
  mock.restore();
});

function asked(type: CommandDraft["type"]): readonly CommandDraft[] {
  return sent.filter((command) => command.type === type);
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

function button(host: HTMLElement, selector: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(selector);
  if (found === null) {
    throw new Error(`no ${selector}`);
  }
  return found;
}

function press(host: HTMLElement, selector: string): void {
  button(host, selector).click();
  flush();
}

function treeRows(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll<HTMLElement>("[role='treeitem']")].map(
    (row) => row.dataset.path ?? ""
  );
}

function code(host: HTMLElement): string {
  return (
    host.querySelector<HTMLElement>(
      "section[aria-label='Files'] [data-file-lines], section[aria-label='Files'] .pim-markdown"
    )?.textContent ?? ""
  );
}

async function files(): Promise<HTMLElement> {
  const host = mountPoint();
  dispose = render(
    () => <Shell store={store} settings={new Settings()} />,
    host
  );
  flush();
  press(host, "[aria-label^='Files and Diffs']");
  press(host, "button[aria-label='Files']");
  await settle(() => treeRows(host).length > 0, "the file tree");
  return host;
}

test("Files keeps the change totals and opens the commit flow", async () => {
  const host = await files();
  const selector =
    "section[aria-label='Files'] header button[title='Write a commit from these changes']";
  await settle(
    () => host.querySelector(selector) !== null,
    "the commit action"
  );
  const header = host.querySelector("section[aria-label='Files'] header")!;
  expect(header.textContent).toContain("+1");
  expect(header.textContent).toContain("−1");
  press(host, selector);
  expect(
    host.querySelector<HTMLDialogElement>("dialog[aria-label='Commit']")?.open
  ).toBe(true);
});

test("outside Git the header opens Files directly and can read a file", async () => {
  await rm(join(repo, ".git"), { recursive: true });
  await store.refreshGit();
  expect(store.state.branch).toBeUndefined();
  const host = mountPoint();
  dispose = render(
    () => <Shell store={store} settings={new Settings()} />,
    host
  );
  flush();
  const browse = button(host, "[aria-label='Files and Diffs']");
  expect(browse.title).toBe("Files and Diffs");
  browse.click();
  await settle(() => treeRows(host).length > 0, "the non-Git file tree");
  expect(host.querySelector("section[aria-label='Files']")).not.toBeNull();
  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the non-Git file");
});

test("the files segment lists folders first and reads a file once picked", async () => {
  const host = await files();

  expect(treeRows(host)).toEqual(["src", "README.md"]);
  await settle(
    () =>
      host.querySelector("[data-path='src'] [aria-label='holds changes']") !==
      null,
    "the closed folder's change marker"
  );

  press(host, "[data-path='src']");
  expect(treeRows(host)).toEqual(["src", "src/alpha.ts", "README.md"]);
  expect(
    host.querySelector("[data-path='src/alpha.ts'] [aria-label='modified']")
  ).not.toBeNull();

  press(host, "[data-path='src/alpha.ts']");
  await settle(() => code(host).includes("THREE"), "the file's lines");
  expect(code(host)).toContain("one");
  expect(host.textContent).not.toContain("3 lines");
  const diffButton = host.querySelector(
    'button[aria-label="Show this file\'s changes"]'
  );
  expect(diffButton?.textContent?.trim()).toBe("");
  expect(
    diffButton?.querySelector("[class~='i-griddy-icons:code-compare']")
  ).not.toBeNull();
  expect(
    diffButton?.parentElement?.querySelector("[aria-label='modified']")
  ).toBeNull();
  expect(host.querySelector("[aria-label='Browse']")).toBeNull();
  expect(asked("read_file")).toEqual([
    {
      type: "read_file",
      sessionId: store.state.sessionId,
      path: "src/alpha.ts",
    },
  ]);
});

function marks(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-mark]")].map(
    (mark) =>
      `${mark.parentElement?.textContent?.trim().split(/\s+/)[0]}:${mark.dataset.mark}`
  );
}

test("a changed file marks its changed lines in the gutter", async () => {
  await Bun.write(join(repo, "fresh.ts"), "x\ny\n");
  const host = await files();
  press(host, "[data-path='src']");
  press(host, "[data-path='src/alpha.ts']");
  await settle(() => marks(host).length > 0, "the change marks");
  expect(marks(host)).toEqual(["3:modified"]);

  press(host, "[data-path='fresh.ts']");
  await settle(() => code(host).includes("y"), "the new file");
  await settle(() => marks(host).length === 2, "the new file's marks");
  expect(marks(host)).toEqual(["1:added", "2:added"]);

  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the clean file");
  expect(marks(host)).toEqual([]);
});

test("the filter answers matching paths whole, and Escape clears it", async () => {
  const host = await files();
  const field = host.querySelector<HTMLInputElement>(
    "input[aria-label='Filter files']"
  )!;

  field.value = "alp";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(treeRows(host)).toEqual(["src/alpha.ts"]);

  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  flush();
  expect(treeRows(host)).toEqual(["src", "README.md"]);
});

test("a changed file links to its diff, and the diff links back", async () => {
  const host = await files();
  press(host, "[data-path='src']");
  press(host, "[data-path='src/alpha.ts']");
  await settle(
    () => host.querySelector("button[title^='Show this file']") !== null,
    "the file's link to its diff"
  );

  press(host, "button[title^='Show this file']");
  await settle(
    () =>
      host
        .querySelector("button[aria-label='src/alpha.ts']")
        ?.getAttribute("aria-expanded") === "true",
    "the file's diff, open"
  );
  expect(host.querySelector("section[aria-label='Files']")).toBeNull();

  press(host, "button[aria-label='View src/alpha.ts']");
  await settle(() => code(host).includes("THREE"), "the file again");
  expect(
    button(host, "[data-path='src/alpha.ts']").getAttribute("aria-selected")
  ).toBe("true");
});

test("a line comment in the viewer joins the review", async () => {
  const host = await files();
  press(host, "[data-path='src']");
  press(host, "[data-path='src/alpha.ts']");
  await settle(() => code(host).includes("THREE"), "the file's lines");

  press(host, "[aria-label='Comment on new line 1']");
  const field = host.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Comment on src/alpha.ts']"
  )!;
  field.value = "say more";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  expect(host.textContent).toContain("1 comment");
  expect(
    button(host, "[data-path='src/alpha.ts']").querySelector(
      "[aria-label='1 comment']"
    )
  ).not.toBeNull();
});

test("Markdown always renders as preview without a source switch", async () => {
  await Bun.write(
    join(repo, "README.md"),
    "# Title\n\n| Name | Value |\n| --- | --- |\n| Alpha | **bold** |\n\n```ts\nconst answer = 42;\n```\n"
  );
  const host = await files();
  press(host, "[data-path='README.md']");
  await settle(
    () => host.querySelector(".pim-markdown table") !== null,
    "Markdown preview"
  );
  expect(host.querySelector(".pim-markdown h1")?.textContent).toBe("Title");
  expect(host.querySelector(".pim-markdown strong")?.textContent).toBe("bold");
  expect(host.querySelector(".pim-markdown pre code")?.textContent).toContain(
    "const answer = 42;"
  );
  expect(host.querySelector("[data-file-lines]")).toBeNull();
  expect(host.querySelector("[aria-label='Markdown view']")).toBeNull();
  expect(host.querySelector("[aria-label='Comment on new line 1']")).toBeNull();
  const copy = button(host, "[aria-label='Copy path']");
  expect(copy.previousElementSibling?.textContent).toContain("README.md");
  expect(copy.nextElementSibling).toBeNull();
  expect(copy.querySelector("span")?.classList.contains("size-4")).toBe(true);
  expect(copy.classList.contains("text-neutral-400")).toBe(true);
  expect(copy.classList.contains("bg-neutral-850")).toBe(false);

  press(host, "[data-path='src']");
  press(host, "[data-path='src/alpha.ts']");
  await settle(() => code(host).includes("THREE"), "source file");
  expect(host.querySelector("[aria-label='Markdown view']")).toBeNull();
  press(host, "[data-path='README.md']");
  await settle(
    () => host.querySelector(".pim-markdown table") !== null,
    "default preview on reopening"
  );
});

test("a file that changes on disk is read again in place", async () => {
  const host = await files();
  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the file's lines");
  const build = spyOn(FileTree, "build");

  await Bun.write(join(repo, "README.md"), "# rewritten\n");
  await store.refreshGit();

  await settle(() => code(host).includes("rewritten"), "the new lines");
  expect(build).not.toHaveBeenCalled();
});

test("a file written in an ignored nested repository joins the tree once files change", async () => {
  const inner = join(repo, "inner");
  await mkdir(inner);
  await makeRepo(inner, ["feat/inner"]);
  await Bun.write(join(repo, ".git/info/exclude"), "inner/\n");
  await Bun.write(join(inner, "notes.md"), "# notes\n");
  const host = await files();
  press(host, "[data-path='inner']");

  await Bun.write(join(inner, "later.md"), "# later\n");
  store.ingest({ type: "picker_invalidate", scope: "files", cwd: repo });

  await settle(
    () => treeRows(host).includes("inner/later.md"),
    "the new file in the tree"
  );
});

test("a binary file says so instead of painting bytes", async () => {
  await Bun.write(join(repo, "blob.bin"), new Uint8Array([0, 1, 2]));
  const host = await files();

  press(host, "[data-path='blob.bin']");

  await settle(
    () => host.textContent?.includes("Unable to view binary file") === true,
    "the binary notice"
  );
  const notice = [...host.querySelectorAll("p")].find(
    (element) => element.textContent === "Unable to view binary file"
  );
  expect(notice?.classList.contains("text-amber-400")).toBe(true);
});

test("on a narrow screen Browse returns to the file list instead of opening a drawer", async () => {
  narrow();
  const host = await files();
  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the file's lines");

  expect(treeRows(host)).toEqual([]);
  expect(
    host.querySelector("[aria-label='Back to the conversation']")
  ).not.toBeNull();

  const explorer = button(host, "[aria-label='Browse']");
  expect(explorer.textContent).toBe("Browse");
  expect(
    explorer.querySelector("[class~='i-griddy-icons:folders']")
  ).not.toBeNull();
  expect(explorer.parentElement?.tagName).toBe("HEADER");
  expect(
    explorer.previousElementSibling?.contains(
      host.querySelector("button[aria-label='Files']")
    )
  ).toBe(true);
  expect(host.querySelector("[aria-label='Show the files']")).toBeNull();
  press(host, "[aria-label='Browse']");
  expect(host.querySelector("dialog[aria-label='Files']")).toBeNull();
  expect(code(host)).toBe("");
  expect(treeRows(host)).toEqual(["src", "README.md"]);

  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the same file reopened");
  expect(treeRows(host)).toEqual([]);
  press(host, "[aria-label='Browse']");

  press(host, "[data-path='src']");
  press(host, "[data-path='src/alpha.ts']");
  await settle(() => code(host).includes("THREE"), "the other file");
  expect(host.querySelector("dialog[aria-label='Files']")).toBeNull();
  expect(treeRows(host)).toEqual([]);
});
