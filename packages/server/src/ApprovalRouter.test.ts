import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { Tools, type ErasedToolEffect } from "#core/shared/Tools";
import {
  ApprovalRouter,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ToolGate,
} from "./ApprovalRouter";

const pathSchema = Type.Object({ path: Type.String() });
const textSchema = Type.Object({ text: Type.String() });

/** `ToolEffect` with the argument type left to each call site to name. */
type TestEffect =
  | { readonly kind: "readOnly" }
  | { readonly kind: "unbounded" }
  | {
      readonly kind: "writesPaths";
      readonly paths: (args: never) => readonly string[];
    };

/** Registering through `wrap` is how a tool's effect reaches the router. */
function register(name: string, effect?: TestEffect): void {
  Tools.wrap({
    name,
    label: name,
    description: name,
    parameters: name === "writer" ? pathSchema : textSchema,
    execute: async () => ({ content: [], details: undefined }),
    ...(effect === undefined ? {} : { effect: effect as ErasedToolEffect }),
  } as never);
}

let cwd: string;
let outside: string;
let router: ApprovalRouter;
let requests: ApprovalRequest[];
let resolutions: readonly [ApprovalRequest, ApprovalOutcome][];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "pim-approval-test-"));
  // Realpath the root itself: /tmp is a symlink on some systems, and the
  // policy compares canonical paths.
  cwd = await Bun.$`realpath ${join(root, "work")}`
    .quiet()
    .nothrow()
    .text()
    .then((s) => s.trim() || join(root, "work"));
  outside = join(root, "elsewhere");
  await mkdir(cwd, { recursive: true });
  await mkdir(outside, { recursive: true });
  requests = [];
  resolutions = [];
  router = new ApprovalRouter({
    cwd: () => cwd,
    onRequest: (request) => {
      requests.push(request);
    },
    onResolved: (request, outcome) => {
      resolutions = [...resolutions, [request, outcome]];
    },
  });
});

afterEach(async () => {
  router.dispose();
  await rm(join(cwd, ".."), { recursive: true, force: true });
});

test("tier 1: a declared read-only tool never asks", async () => {
  register("reader", { kind: "readOnly" });
  expect(await router.classify("reader", { text: "x" })).toMatchObject({
    tier: 1,
  });
});

test("tier 2: writes resolved inside the session cwd auto-approve", async () => {
  register("writer", {
    kind: "writesPaths",
    paths: (a: { path: string }) => [a.path],
  });
  await mkdir(join(cwd, "sub"), { recursive: true });
  for (const path of [
    "file.txt",
    "sub/file.txt",
    "sub/../file.txt",
    "./nested/dirs/that/do/not/exist/yet.txt",
    join(cwd, "absolute.txt"),
    ".",
  ]) {
    expect([path, await router.classify("writer", { path })]).toEqual([
      path,
      { tier: 2, reason: `writer writes only inside ${cwd}` },
    ]);
  }
});

test("tier 2 becomes tier 3 for every way out of the cwd", async () => {
  register("writer", {
    kind: "writesPaths",
    paths: (a: { path: string }) => [a.path],
  });
  await mkdir(join(cwd, "sub"), { recursive: true });
  await symlink(outside, join(cwd, "escape"));
  await symlink(join(outside, "target.txt"), join(cwd, "escape.txt"));
  await writeFile(join(outside, "target.txt"), "");

  for (const path of [
    "../elsewhere/file.txt",
    "sub/../../elsewhere/file.txt",
    "/etc/passwd",
    outside,
    join(outside, "file.txt"),
    // A symlinked directory inside the cwd that points out of it.
    "escape/file.txt",
    // ...and the same trick with a `..` that lexical normalisation folds away
    // before ever looking at the symlink: `path.resolve` calls this one
    // `<cwd>/secret.txt` and would wave it through.
    "escape/../secret.txt",
    // A symlinked file inside the cwd whose target is outside.
    "escape.txt",
    "~/file.txt",
  ]) {
    const classification = await router.classify("writer", { path });
    expect([path, classification.tier]).toEqual([path, 3]);
  }
});

test("a symlink that leads back inside the cwd still auto-approves", async () => {
  register("writer", {
    kind: "writesPaths",
    paths: (a: { path: string }) => [a.path],
  });
  await mkdir(join(cwd, "real"), { recursive: true });
  await symlink(join(cwd, "real"), join(cwd, "alias"));
  expect(
    await router.classify("writer", { path: "alias/file.txt" })
  ).toMatchObject({ tier: 2 });
});

test("~ expands to the home directory, not to a name under the cwd", async () => {
  register("writer", {
    kind: "writesPaths",
    paths: (a: { path: string }) => [a.path],
  });
  const classification = await router.classify("writer", { path: "~/x.txt" });
  expect(classification.tier).toBe(3);
  expect(classification.reason).toContain(homedir());
});

test("tier 3: unbounded, undeclared, unparseable, and pathless calls", async () => {
  register("shell", { kind: "unbounded" });
  register("mystery");
  register("thrower", {
    kind: "writesPaths",
    paths: () => {
      throw new Error("patch did not parse");
    },
  });
  register("empty", { kind: "writesPaths", paths: () => [] });

  expect((await router.classify("shell", {})).tier).toBe(3);
  expect(await router.classify("mystery", {})).toEqual({
    tier: 3,
    reason: "mystery does not declare what it can touch",
  });
  expect((await router.classify("thrower", {})).reason).toContain(
    "patch did not parse"
  );
  expect((await router.classify("empty", {})).reason).toContain(
    "named no target path"
  );
  expect((await router.classify("never-registered", {})).tier).toBe(3);
});

test("every declared target must be inside the cwd, not just the first", async () => {
  register("multi", {
    kind: "writesPaths",
    paths: (a: { paths: readonly string[] }) => a.paths,
  });
  expect(
    (await router.classify("multi", { paths: ["a.txt", "b.txt"] })).tier
  ).toBe(2);
  expect(
    (await router.classify("multi", { paths: ["a.txt", "../b.txt"] })).tier
  ).toBe(3);
});

test("the first decision wins and a second one cannot corrupt it", async () => {
  register("shell", { kind: "unbounded" });
  const agent = fakeAgent();
  router.install(agent.session);

  const call = agent.callTool("shell", "call_1", {});
  await waitFor(() => requests.length === 1);

  expect(router.pending.map((r) => r.callId)).toEqual(["call_1"]);
  expect(router.resolve("call_1", true)).toEqual({ ok: true });
  expect(router.resolve("call_1", false)).toEqual({
    ok: false,
    error: "approval for call_1 was already resolved: approved by a client",
  });
  expect(await call).toBeUndefined();
  expect(router.pending).toEqual([]);
  expect(resolutions.map(([, outcome]) => outcome.approved)).toEqual([true]);
});

test("a denial blocks the call with the reason the client gave", async () => {
  register("shell", { kind: "unbounded" });
  const agent = fakeAgent();
  router.install(agent.session);

  const call = agent.callTool("shell", "call_2", {});
  await waitFor(() => requests.length === 1);
  router.resolve("call_2", false);
  expect(await call).toEqual({ block: true, reason: "denied by a client" });
});

test("answering a call nobody asked about is an error, not a crash", () => {
  expect(router.resolve("nope", true)).toEqual({
    ok: false,
    error: "no approval is pending for nope",
  });
});

test("aborting the turn frees a parked call with no client attached", async () => {
  register("shell", { kind: "unbounded" });
  const agent = fakeAgent();
  router.install(agent.session);

  const call = agent.callTool("shell", "call_3", {});
  await waitFor(() => requests.length === 1);
  agent.abort();
  expect(await call).toEqual({ block: true, reason: "the turn was aborted" });
  expect(router.pending).toEqual([]);
});

test("dispose releases every parked call and refuses new ones", async () => {
  register("shell", { kind: "unbounded" });
  const agent = fakeAgent();
  router.install(agent.session);

  const call = agent.callTool("shell", "call_4", {});
  await waitFor(() => requests.length === 1);
  router.dispose();
  expect(await call).toEqual({
    block: true,
    reason: "the session stopped waiting for an answer",
  });
  expect(await agent.callTool("shell", "call_5", {})).toEqual({
    block: true,
    reason: "the session is shutting down",
  });
});

test("install composes with the hook pi already put on the agent", async () => {
  register("reader", { kind: "readOnly" });
  const agent = fakeAgent();
  const seen: string[] = [];
  agent.session.agent.beforeToolCall = async ({ toolCall }) => {
    seen.push(toolCall.name);
    return undefined;
  };
  const uninstall = router.install(agent.session);
  expect(
    await agent.callTool("reader", "call_6", { text: "x" })
  ).toBeUndefined();
  expect(seen).toEqual(["reader"]);
  uninstall();
  expect(agent.session.agent.beforeToolCall).toBeDefined();
  expect(
    await agent.callTool("reader", "call_7", { text: "x" })
  ).toBeUndefined();
  expect(seen).toEqual(["reader", "reader"]);
});

type BlockResult = { readonly block?: boolean; readonly reason?: string };

/**
 * Pi's tool gate without pi: `Agent.beforeToolCall` is the only surface the
 * router touches, so a stand-in that calls it the way the agent loop does is a
 * faithful driver. Real turns run in `WsGateway.approvals.test.ts`.
 */
function fakeAgent(): {
  readonly session: ToolGate;
  readonly callTool: (
    name: string,
    id: string,
    args: unknown
  ) => Promise<BlockResult | undefined>;
  readonly abort: () => void;
} {
  const controller = new AbortController();
  const session: ToolGate = { agent: {} };
  return {
    session,
    callTool: async (name, id, args) =>
      await session.agent.beforeToolCall?.(
        { toolCall: { id, name }, args } as never,
        controller.signal
      ),
    abort: () => {
      controller.abort();
    },
  };
}

async function waitFor(test: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !test(); i++) {
    await Bun.sleep(5);
  }
  expect(test()).toBe(true);
}
