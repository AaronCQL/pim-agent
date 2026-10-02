import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { flush } from "solid-js";

import { git, makeRepo } from "#core/shared/fixtures/repo";
import { Proc } from "#core/shared/Proc";
import type { ChangeList, FileDiff } from "#protocol/Diff";
import type { CommandDraft } from "#protocol/Command";
import type { ResponseEvent } from "#protocol/ServerEvent";
import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import { GatewayHarness } from "../test/gateway";
import { until } from "#core/shared/fixtures/wait";
import { DiffStore } from "./DiffStore";
import { DiffView } from "./DiffView";

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
  // `Git.commit` doesn't get the fixture's identity env.
  await git(repo, ["config", "user.email", "pim@example.com"]);
  await git(repo, ["config", "user.name", "pim"]);
  store = new SessionStore({
    url: harness.url,
    cwd: repo,
    pickerDebounceMs: 0,
  });
  await store.connect();
  sent = [];
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  store.dispose();
  await harness.stop();
  mock.restore();
});

/** Two committed-then-edited files; waits for the server's git refresh so no stray re-read lands mid-test. */
async function seed(): Promise<void> {
  await Bun.write(join(repo, "alpha.ts"), "one\ntwo\nthree\n");
  await Bun.write(join(repo, "src/beta.ts"), "alpha\nbeta\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "seed"]);
  await Bun.write(join(repo, "alpha.ts"), "one\ntwo\nTHREE\n");
  await Bun.write(join(repo, "src/beta.ts"), "alpha\nBETA\n");
  await store.refreshGit();
}

/** Records every command, optionally stubbing the answer. */
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
    () => (
      <DiffView
        diff={new DiffStore(store, 0)}
        settings={new Settings()}
        inset={0}
        onClose={() => {}}
      />
    ),
    host
  );
  flush();
  return host;
}

function rows(host: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...(changesPane(host) ?? host).querySelectorAll<HTMLButtonElement>(
      "button[aria-expanded]"
    ),
  ].filter((button) => button.getAttribute("aria-haspopup") === null);
}

function labels(host: HTMLElement): readonly string[] {
  return rows(host).map((row) => row.getAttribute("aria-label") ?? "");
}

function box(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Commit message']"
  );
}

function openCommit(host: HTMLElement): void {
  host
    .querySelector<HTMLButtonElement>(
      "[title='Write a commit from these changes']"
    )
    ?.click();
  flush();
}

function pick(host: HTMLElement, path: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `dialog [role='checkbox'][aria-label='${path}']`
  )!;
}

function submit(host: HTMLElement): void {
  [...host.querySelectorAll<HTMLButtonElement>("dialog button")]
    .find((button) => button.textContent?.trim().startsWith("Commit"))
    ?.click();
  flush();
}

function write(host: HTMLElement, message: string): void {
  const field = box(host) as HTMLTextAreaElement;
  field.value = message;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

async function gitOut(args: readonly string[]): Promise<string> {
  const { stdout } = await Proc.run(["git", ...args], { cwd: repo });
  return stdout.trim();
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

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

function dirty(count: number, revision = `r${count}`): void {
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
    repoRevision: revision,
  });
}

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
  expect(host.textContent).toContain("+2");
  expect(host.textContent).toContain("−2");
});

test("added and removed are divided by a slash, and only when both are there", async () => {
  await seed();
  await Bun.write(join(repo, "gamma.ts"), "only\nmore\n");
  const host = await open();

  await settle(() => rows(host).length === 3, "all three rows");
  const [alpha, , gamma] = rows(host);
  expect(alpha?.textContent).toContain("+1/−1");
  expect(gamma?.textContent).toContain("+2");
  expect(gamma?.textContent).not.toContain("/−");
  expect(host.querySelector("header")?.textContent).toContain("+4/−2");
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
  await store.refreshGit();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  rows(host)[0]?.click();
  await settle(() => asked("file_diff").length === 1, "the first diff");

  host.querySelector<HTMLButtonElement>("[aria-haspopup='listbox']")?.click();
  flush();
  [...host.querySelectorAll<HTMLElement>("[role='option']")]
    .find((option) => option.textContent?.includes("Staged"))
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

function shell(): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => <Shell store={store} settings={new Settings()} />,
    host
  );
  flush();
  return host;
}

function changesPane(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("section[aria-label='Changes']");
}

function transcript(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("div.h-full.flex-col-reverse");
}

function openDiff(host: HTMLElement): void {
  host
    .querySelector<HTMLButtonElement>("[aria-label^='Review changes']")
    ?.click();
  flush();
}

test("the changes segment opens the change set while an agent is working", async () => {
  await seed();
  const host = shell();
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

  const diff = host.querySelector<HTMLButtonElement>(
    "[aria-label^='Review changes']"
  );
  expect(diff?.disabled).toBe(false);
  expect(diff?.textContent).toBe("2");

  diff?.click();
  await settle(() => rows(host).length === 2, "the change set's rows");
  expect(changesPane(host)).not.toBeNull();
});

test("the change set replaces the transcript and keeps the composer", async () => {
  await seed();
  watch();
  const host = shell();
  store.ingest({
    seq: 1,
    type: "message",
    messageId: "u1",
    role: "user",
    text: "the conversation so far",
    timestamp: 0,
  });
  flush();
  expect(transcript(host)?.textContent).toContain("the conversation so far");

  openDiff(host);
  await settle(() => rows(host).length === 2, "the change set's rows");

  expect(transcript(host)).toBeNull();
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector("dialog[open]")).toBeNull();

  host
    .querySelector<HTMLButtonElement>("[aria-label='Back to the conversation']")
    ?.click();
  flush();
  expect(changesPane(host)).toBeNull();
  expect(transcript(host)?.textContent).toContain("the conversation so far");
});

test("closing and reopening does not read the repository again", async () => {
  await seed();
  watch();
  const host = shell();
  openDiff(host);
  await settle(() => rows(host).length === 2, "the change set's rows");
  const reads = asked("list_changes").length;

  host
    .querySelector<HTMLButtonElement>("[aria-label='Back to the conversation']")
    ?.click();
  flush();
  openDiff(host);

  await settle(() => rows(host).length === 2, "the rows again");
  expect(asked("list_changes").length).toBe(reads);
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

test("a repository that moves re-reads itself, keeping the open file open", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");
  rows(host)[0]?.click();
  await settle(() => host.textContent?.includes("THREE") === true, "the hunks");
  dirty(2, "before");

  await Bun.write(join(repo, "alpha.ts"), "one\ntwo\nFOUR\n");
  dirty(2, "after");

  await settle(
    () => host.textContent?.includes("FOUR") === true,
    "the re-read hunks"
  );
  expect(host.textContent).not.toContain("THREE");
  expect(rows(host)[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[title='Read the change list again']")).toBeNull();
});

test("a repository that loses a change drops its row", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");
  dirty(2, "before");

  await Bun.write(join(repo, "src/beta.ts"), "alpha\nbeta\n");
  dirty(1, "after");

  await settle(() => rows(host).length === 1, "the row that is left");
  expect(labels(host)).toEqual(["alpha.ts"]);
});

test("a repository that moves while the change set is closed is read on return", async () => {
  await seed();
  watch();
  const host = shell();
  openDiff(host);
  await settle(() => rows(host).length === 2, "the change set's rows");
  dirty(2, "before");
  const reads = asked("list_changes").length;

  host
    .querySelector<HTMLButtonElement>("[aria-label='Back to the conversation']")
    ?.click();
  flush();
  await Bun.write(join(repo, "gamma.ts"), "new\n");
  dirty(3, "after");
  expect(asked("list_changes").length).toBe(reads);

  openDiff(host);
  await settle(() => rows(host).length === 3, "the row the edit added");
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

async function longFile(
  lines: number,
  edits: readonly number[]
): Promise<void> {
  const text = Array.from({ length: lines }, (_, at) => `line ${at + 1}`);
  await Bun.write(join(repo, "long.ts"), `${text.join("\n")}\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "long"]);
  for (const edit of edits) {
    text[edit - 1] = `LINE ${edit}`;
  }
  await Bun.write(join(repo, "long.ts"), `${text.join("\n")}\n`);
}

function gaps(host: HTMLElement): readonly HTMLButtonElement[] {
  return [
    ...host.querySelectorAll<HTMLButtonElement>("button[aria-label^='Show ']"),
  ];
}

test("a gap says how many lines it hides, and opens them when clicked", async () => {
  await longFile(60, [3, 55]);
  const host = await open();
  await settle(() => rows(host).length === 1, "the row");

  rows(host)[0]?.click();
  await settle(() => gaps(host).length === 2, "both gaps");

  expect(host.textContent).toContain("45 lines unchanged");
  expect(host.textContent).toContain("2 lines unchanged");
  expect(host.textContent).not.toContain("line 30");

  gaps(host)[0]?.click();
  await settle(
    () => host.textContent?.includes("line 30") === true,
    "the lines behind the gap"
  );

  expect(asked("read_lines")).toEqual([
    {
      type: "read_lines",
      sessionId: store.state.sessionId,
      base: { kind: "worktree" },
      path: "long.ts",
      spans: [{ start: 7, end: 51 }],
    },
  ]);
  expect(host.textContent).not.toContain("45 lines unchanged");
  expect(host.textContent).toContain("2 lines unchanged");
});

test("a gap too wide to swallow opens a step against each hunk", async () => {
  await longFile(400, [3, 395]);
  const host = await open();
  await settle(() => rows(host).length === 1, "the row");

  rows(host)[0]?.click();
  await settle(() => gaps(host).length > 0, "the gap");
  expect(host.textContent).toContain("385 lines unchanged");

  gaps(host)[0]?.click();
  await settle(
    () => host.textContent?.includes("line 7") === true,
    "the first step"
  );

  expect(asked("read_lines")[0]).toMatchObject({
    spans: [
      { start: 7, end: 31 },
      { start: 367, end: 391 },
    ],
  });
  expect(host.textContent).toContain("line 391");
  expect(host.textContent).toContain("335 lines unchanged");

  gaps(host)[0]?.click();
  await settle(
    () => host.textContent?.includes("285 lines unchanged") === true,
    "the second step"
  );
  expect(asked("read_lines")).toHaveLength(2);
});

test("a commit writes exactly the picked files and leaves the rest dirty", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  openCommit(host);
  pick(host, "src/beta.ts").click();
  flush();
  write(host, "the reviewed change");
  submit(host);

  await settle(() => rows(host).length === 1, "the list the commit emptied");
  expect(await gitOut(["log", "-1", "--pretty=%s"])).toBe(
    "the reviewed change"
  );
  expect(await gitOut(["diff", "--name-only"])).toBe("src/beta.ts");
  expect(labels(host)).toEqual(["src/beta.ts"]);
  expect(host.querySelector("header")?.textContent).toContain(
    `committed ${await gitOut(["rev-parse", "--short", "HEAD"])}`
  );
  expect(host.querySelector("dialog")?.open).toBe(false);
});

test("a refused commit keeps the picks and the message that was refused", async () => {
  await seed();
  watch((command) =>
    command.type === "commit"
      ? {
          type: "response",
          id: "stub",
          success: false,
          error: "the agent is working in this repository",
        }
      : undefined
  );
  const host = paint();
  await settle(() => rows(host).length === 2, "both rows");

  openCommit(host);
  pick(host, "src/beta.ts").click();
  flush();
  write(host, "half a tree");
  submit(host);

  await settle(
    () => host.textContent?.includes("the agent is working") === true,
    "the refusal"
  );
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(box(host)?.value).toBe("half a tree");
  expect(pick(host, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  expect(pick(host, "src/beta.ts").getAttribute("aria-checked")).toBe("false");
  expect(await gitOut(["log", "-1", "--pretty=%s"])).toBe("seed");
});

test("a half-written message survives leaving the review and coming back", async () => {
  await seed();
  watch();
  const host = shell();
  openDiff(host);
  await settle(() => rows(host).length === 2, "the change set's rows");

  openCommit(host);
  write(host, "half written");
  host.querySelector<HTMLButtonElement>("dialog [aria-label='Close']")?.click();
  flush();

  host
    .querySelector<HTMLButtonElement>("[aria-label='Back to the conversation']")
    ?.click();
  flush();
  expect(changesPane(host)).toBeNull();

  openDiff(host);
  await settle(() => rows(host).length === 2, "the rows again");
  openCommit(host);
  expect(box(host)?.value).toBe("half written");
});
