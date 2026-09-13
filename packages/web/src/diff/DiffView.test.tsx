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
import { GatewayHarness, until } from "../test/gateway";
import { DiffStore } from "./DiffStore";
import { DiffView } from "./DiffView";

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
  // `Git.commit` runs without the fixture's identity env, so the repository carries its own.
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
    () => (
      <DiffView
        diff={new DiffStore(store)}
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
    ...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ].filter((button) => button.getAttribute("aria-haspopup") === null);
}

function labels(host: HTMLElement): readonly string[] {
  return rows(host).map((row) => row.getAttribute("aria-label") ?? "");
}

/** The modal's own message box, which is only there while it is open. */
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

/** One file's row in the modal, by the path it names. */
function pick(host: HTMLElement, path: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    `dialog [role='checkbox'][aria-label='${path}']`
  )!;
}

/** The modal's button, which reads the same as the toolbar's that opened it. */
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
  expect(host.textContent).toContain("+2");
  expect(host.textContent).toContain("−2");
});

/*
 * A file's stat is the one a diff tool's own title carries: `+1/−1`, the
 * slash binding the two counts so neither reads as a stray number on a bar
 * that also holds a path. A file that only grew has one count and no slash to
 * divide it from — a trailing `/` would promise a removal that never happened.
 */
test("added and removed are divided by a slash, and only when both are there", async () => {
  await seed();
  await Bun.write(join(repo, "gamma.ts"), "only\nmore\n");
  const host = await open();

  await settle(() => rows(host).length === 3, "all three rows");
  const [alpha, , gamma] = rows(host);
  expect(alpha?.textContent).toContain("+1/−1");
  expect(gamma?.textContent).toContain("+2");
  expect(gamma?.textContent).not.toContain("/−");
  // The whole tree's stat over the pane reads the same way.
  expect(host.querySelector("header")?.textContent).toContain("+4/−2");
});

/*
 * A diff is read by scrolling, and a hunk halfway down a long file says
 * nothing about which file it belongs to. The title bar pins to the top of the
 * list for as long as any of its file is on screen, and is opaque while it is
 * there: the bar of the next file slides over this one on its way past, and
 * two see-through bars would be legible through each other. Being positioned
 * is not enough to cover what it scrolls over: an icon is painted through a
 * mask, which is a stacking context of its own, so the icons of the hunks
 * below would show through an unlayered bar. It takes a layer, and the list
 * around it is isolated so that layer never reaches the composer floating at
 * the foot.
 */
test("a file's title bar pins to the top of the list, opaque", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  const bar = (): HTMLElement => rows(host)[0]?.parentElement as HTMLElement;
  expect(bar().className).toContain("sticky");
  expect(bar().className).toContain("top-0");
  expect(bar().className).toContain("bg-neutral-925");
  expect(bar().className).toMatch(/\bz-\d/);
  const list = bar().parentElement?.parentElement as HTMLElement;
  expect(list.className).toContain("isolate");
  expect(list.className).toContain("overflow-y-auto");

  rows(host)[0]?.click();
  await settle(() => host.textContent?.includes("THREE") === true, "the hunks");
  expect(bar().className).toContain("sticky");
  expect(bar().className).toContain("bg-neutral-850");
});

/*
 * A row is a thing to click, so all of it is the button: the padding that
 * gives the row its height belongs to the button rather than the bar around
 * it, or the top and bottom few pixels of every row swallow a click. Nothing
 * shares the bar with it: what goes in a commit is asked in the modal.
 */
test("the row is the button, top to bottom", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  const row = rows(host)[0] as HTMLElement;
  const bar = row.parentElement as HTMLElement;
  expect(bar.className).not.toMatch(/\bpy-/);
  expect(row.className).toContain("py-1.5");
  expect(bar.querySelector("[role='checkbox']")).toBeNull();
  expect(host.querySelector("header [role='checkbox']")).toBeNull();
});

/*
 * A move is one path, not two: everything the old and new names agree on is
 * said once and the segments that changed are braced, exactly as the patch
 * tool titles a move — same arrow, same strike through what is gone.
 */
test("a renamed file reads as one braced path", async () => {
  await seed();
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "edits"]);
  await git(repo, ["mv", "src/beta.ts", "src/gamma.ts"]);
  const host = await open();

  await settle(() => rows(host).length === 1, "the renamed row");
  const row = rows(host)[0] as HTMLElement;
  expect(row.textContent).toContain("src/{beta.ts ➝ gamma.ts}");
  expect(row.querySelector(".line-through")?.textContent).toBe("beta.ts");
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

/** The shell's own changes segment, with the change set as its destination. */
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

/** The bottom-origin scroller, which is the transcript and nothing else. */
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

/**
 * The change set takes the transcript's place rather than covering it, and the
 * composer stays where it was: a hunk can be read and answered without going
 * back first.
 */
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

/** Reopening reads the rows out of the store that outlived the last visit. */
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

/** A committed file long enough to leave gaps, edited at both ends. */
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

/** The rows the hunks skip, counted and offered rather than merely marked. */
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

/** A gap no reader wants whole opens a step at a time, from each hunk it touches. */
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

/** The pane is for reading; what a commit is made of is asked in the modal. */
test("the toolbar offers the whole change set, and the modal arrives holding it", async () => {
  await seed();
  const host = await open();
  await settle(() => rows(host).length === 2, "both rows");

  expect(box(host)).toBeNull();
  expect(host.querySelector("header")?.textContent).toContain("Commit");

  openCommit(host);

  expect(box(host)).not.toBeNull();
  expect(document.activeElement).toBe(box(host));
  expect(pick(host, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  expect(pick(host, "src/beta.ts").getAttribute("aria-checked")).toBe("true");
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
  // The modal is done: what it wrote is read back in the pane it emptied.
  expect(host.querySelector("dialog")?.open).toBe(false);
});

/*
 * A move is two names in one row, and a commit of only the new one leaves the
 * old path behind in the tree; both go on the pathspec.
 */
test("a rename goes on the commit by both of its names", async () => {
  await seed();
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "edits"]);
  await git(repo, ["mv", "src/beta.ts", "src/gamma.ts"]);
  const host = await open();
  await settle(() => rows(host).length === 1, "the renamed row");

  openCommit(host);
  write(host, "renamed");
  submit(host);

  await settle(() => asked("commit").length === 1, "the commit");
  expect(asked("commit")).toEqual([
    {
      type: "commit",
      sessionId: store.state.sessionId,
      message: "renamed",
      paths: ["src/gamma.ts", "src/beta.ts"],
    },
  ]);
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

/*
 * The write we just made is reported back to us as the repository moving, and
 * a list already re-read against it is not stale — it is the newest there is.
 */
test("a commit of our own re-reads the list rather than calling it stale", async () => {
  await seed();
  watch((command) =>
    command.type === "commit"
      ? {
          type: "response",
          id: "stub",
          success: true,
          commit: { sha: "a1b2c3d" },
        }
      : undefined
  );
  const host = paint();
  await settle(() => rows(host).length === 2, "both rows");

  openCommit(host);
  write(host, "the reviewed change");
  submit(host);

  await settle(
    () => asked("list_changes").length === 2,
    "the re-read the commit asks for"
  );
  dirty(7);

  await settle(
    () => asked("list_changes").length === 3,
    "the re-read the state frame asks for"
  );
  expect(host.textContent).not.toContain("The repository has changed");
  expect(host.textContent).toContain("committed a1b2c3d");
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
