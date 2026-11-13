import "../test/dom";

import { render } from "@solidjs/web";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import { makeRepo } from "#core/shared/fixtures/repo";
import { until } from "#core/shared/fixtures/wait";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { GatewayHarness } from "../test/gateway";
import { Topbar } from "./Topbar";

let harness: GatewayHarness;
let repo: string;
let store: SessionStore | undefined;
let dispose: (() => void) | undefined;

beforeEach(async () => {
  localStorage.clear();
  harness = new GatewayHarness();
  await harness.start();
  repo = join(harness.tmp, "repo");
  await mkdir(repo, { recursive: true });
  await makeRepo(repo);
  await Bun.write(join(repo, "outer.txt"), "outer\n");
});

afterEach(async () => {
  dispose?.();
  dispose = undefined;
  store?.dispose();
  store = undefined;
  await harness.stop();
});

async function nest(name = "inner"): Promise<void> {
  const inner = join(repo, name);
  await mkdir(inner);
  await makeRepo(inner, [`feat/${name}`]);
  await Bun.write(join(inner, "fresh.txt"), "fresh\n");
  await Bun.write(join(repo, ".git/info/exclude"), "inner/\nalpha/\n");
}

async function connect(): Promise<SessionStore> {
  const opened = new SessionStore({
    url: harness.url,
    cwd: repo,
    pickerDebounceMs: 0,
  });
  store = opened;
  await opened.connect();
  await until(() => opened.state.branch === "main", "the branch to land");
  return opened;
}

function paint(on: SessionStore): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (
      <Topbar
        store={on}
        compact={false}
        reviewing={false}
        onToggleSidebar={() => {}}
        onToggleDiff={() => {}}
      />
    ),
    host
  );
  flush();
  return host;
}

function segment(host: HTMLElement): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('[aria-label^="Repository "]');
}

function rows(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')];
}

function texts(host: HTMLElement): readonly string[] {
  return rows(host).map((row) => row.textContent ?? "");
}

function row(host: HTMLElement, text: string): HTMLElement {
  const found = rows(host).find((option) => option.textContent === text);
  if (found === undefined) {
    throw new Error(`no row ${text} in ${texts(host).join(", ")}`);
  }
  return found;
}

function pick(host: HTMLElement, text: string): void {
  row(host, text).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  flush();
}

function alert(host: HTMLElement): string {
  return host.querySelector('[role="alert"]')?.textContent ?? "";
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

/** Records every repository lookup the topbar makes. */
function lookups(on: SessionStore): Promise<readonly string[]>[] {
  const listed: Promise<readonly string[]>[] = [];
  const original = on.listRepos.bind(on);
  spyOn(on, "listRepos").mockImplementation(() => {
    const found = original();
    listed.push(found);
    return found;
  });
  return listed;
}

async function opened(on: SessionStore): Promise<HTMLElement> {
  const host = paint(on);
  await settle(() => segment(host) !== null, "the repository segment");
  segment(host)?.click();
  flush();
  return host;
}

test("a cwd with no repository below it paints no repository segment", async () => {
  const on = await connect();
  const listed = lookups(on);
  const host = paint(on);
  await until(() => listed.length > 0, "the repository lookup");

  expect(await listed[0]).toEqual([]);
  flush();
  expect(segment(host)).toBeNull();
});

test("picking a nested repository points the branch chip at it", async () => {
  await nest();
  const on = await connect();
  const host = await opened(on);

  expect(texts(host)).toEqual(["repoworking directory", "inner"]);
  pick(host, "inner");

  await settle(
    () => on.state.repo === "inner" && on.state.branch === "feat/inner",
    "the nested repository's branch"
  );
  expect(segment(host)?.getAttribute("aria-label")).toBe(
    "Repository inner, switch"
  );
  expect(segment(host)?.getAttribute("aria-expanded")).toBe("false");
});

test("a second pick while a switch is in flight is ignored", async () => {
  await nest();
  const on = await connect();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = on.setRepo.bind(on);
  const switches = spyOn(on, "setRepo").mockImplementation(async (repo) => {
    await held;
    await original(repo);
  });
  const host = await opened(on);

  pick(host, "inner");
  pick(host, "inner");
  pick(host, "repoworking directory");

  expect(switches).toHaveBeenCalledTimes(1);
  expect(row(host, "inner").getAttribute("aria-busy")).toBe("true");
  expect(segment(host)?.getAttribute("aria-expanded")).toBe("true");

  release();
  await settle(
    () =>
      on.state.repo === "inner" &&
      segment(host)?.getAttribute("aria-expanded") === "false",
    "the switch to land"
  );
  expect(switches).toHaveBeenCalledTimes(1);
});

test("a refused switch says why and keeps the panel open", async () => {
  await nest();
  const on = await connect();
  const listed = lookups(on);
  const host = await opened(on);
  await until(() => listed.length === 2, "the lookup on open");
  await Promise.all(listed);
  await rm(join(repo, "inner"), { recursive: true });

  pick(host, "inner");

  await settle(() => alert(host) !== "", "the refusal");
  expect(segment(host)?.getAttribute("aria-expanded")).toBe("true");
  expect(row(host, "inner").hasAttribute("aria-busy")).toBe(false);
  expect(on.state.repo).toBe("");
});

test("a selected repository the lookup no longer finds stays listed, last", async () => {
  await nest();
  const on = await connect();
  await on.setRepo("inner");
  spyOn(on, "listRepos").mockResolvedValue([]);
  const host = await opened(on);

  await settle(
    () => texts(host).includes("innernot found"),
    "the missing repository"
  );
  expect(texts(host)).toEqual(["repoworking directory", "innernot found"]);
  expect(row(host, "innernot found").getAttribute("aria-selected")).toBe(
    "true"
  );
});

test("a lookup that lands after the cwd moved is dropped", async () => {
  await nest();
  const on = await connect();
  let answer!: (repos: readonly string[]) => void;
  const original = on.listRepos.bind(on);
  spyOn(on, "listRepos")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    )
    .mockImplementation(original);
  const host = paint(on);
  await until(() => answer !== undefined, "the first lookup");

  const other = join(harness.tmp, "other");
  await mkdir(other);
  await on.openDirectory(other);
  await settle(() => on.state.cwd === other, "the new cwd");
  answer(["inner"]);
  await Promise.resolve();
  flush();

  expect(segment(host)).toBeNull();
});

test("refreshes during a lookup fold into one more lookup", async () => {
  const on = await connect();
  const answers: ((repos: readonly string[]) => void)[] = [];
  const lookup = spyOn(on, "listRepos").mockImplementation(
    () =>
      new Promise((resolve) => {
        answers.push(resolve);
      })
  );
  const host = paint(on);
  await until(() => answers.length === 1, "the first lookup");

  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(lookup).toHaveBeenCalledTimes(1);

  answers[0]?.([]);
  await until(() => answers.length === 2, "the trailing lookup");
  answers[1]?.(["inner"]);
  await settle(() => segment(host) !== null, "the trailing lookup's answer");
  expect(lookup).toHaveBeenCalledTimes(2);
});

test("a repository created after attach shows once files change", async () => {
  const on = await connect();
  const listed = lookups(on);
  const host = paint(on);
  await until(() => listed.length > 0, "the first lookup");
  expect(await listed[0]).toEqual([]);

  await nest();
  on.ingest({ type: "picker_invalidate", scope: "files", cwd: repo });

  await settle(() => segment(host) !== null, "the new repository");
});

test("a lookup landing while the panel is open keeps the highlighted repository", async () => {
  await nest();
  const on = await connect();
  const host = await opened(on);
  await settle(() => rows(host).length === 2, "both rows");
  segment(host)?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
  );
  flush();
  expect(row(host, "inner").getAttribute("aria-selected")).toBe("true");

  await nest("alpha");
  on.ingest({ type: "picker_invalidate", scope: "files", cwd: repo });

  await settle(() => rows(host).length === 3, "the new repository's row");
  expect(texts(host)).toEqual(["repoworking directory", "alpha", "inner"]);
  expect(row(host, "inner").getAttribute("aria-selected")).toBe("true");
});
