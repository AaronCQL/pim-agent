import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
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

afterEach(async () => {
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
    host.querySelector<HTMLElement>("section[aria-label='Files'] .w-max")
      ?.textContent ?? ""
  );
}

async function files(): Promise<HTMLElement> {
  const host = mountPoint();
  dispose = render(
    () => <Shell store={store} settings={new Settings()} />,
    host
  );
  flush();
  press(host, "[aria-label^='Review changes']");
  press(host, "button[aria-label='Files']");
  await settle(() => treeRows(host).length > 0, "the file tree");
  return host;
}

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
  expect(asked("read_file")).toEqual([
    {
      type: "read_file",
      sessionId: store.state.sessionId,
      path: "src/alpha.ts",
    },
  ]);
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
  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the file's lines");

  press(host, "[aria-label='Comment on new line 1']");
  const field = host.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Comment on README.md']"
  )!;
  field.value = "say more";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();

  expect(host.textContent).toContain("1 comment");
  expect(
    button(host, "[data-path='README.md']").querySelector(
      "[aria-label='1 comment']"
    )
  ).not.toBeNull();
});

test("a file that changes on disk is read again in place", async () => {
  const host = await files();
  press(host, "[data-path='README.md']");
  await settle(() => code(host).includes("readme"), "the file's lines");

  await Bun.write(join(repo, "README.md"), "# rewritten\n");
  await store.refreshGit();

  await settle(() => code(host).includes("rewritten"), "the new lines");
});

test("a binary file says so instead of painting bytes", async () => {
  await Bun.write(join(repo, "blob.bin"), new Uint8Array([0, 1, 2]));
  const host = await files();

  press(host, "[data-path='blob.bin']");

  await settle(
    () => host.textContent?.includes("binary file") === true,
    "the binary notice"
  );
});
