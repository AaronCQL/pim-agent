import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SessionMeta } from "./SessionMeta";

let tmp: string;
let file: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-session-meta-"));
  file = join(tmp, "sessions.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("SessionMeta", () => {
  test("an unknown session has no overrides", async () => {
    const meta = new SessionMeta(file);

    expect(await meta.of("s1")).toEqual({});
    expect((await meta.pinning()).projects).toEqual(new Map());
  });

  test("archived, unread and pinned survive a restart", async () => {
    const meta = new SessionMeta(file);
    await meta.setArchived("s1", true);
    await meta.setUnread("s2", true);
    await meta.setPinned("/work/pim", true);

    const restarted = new SessionMeta(file);
    expect(await restarted.of("s1")).toEqual({ archived: true });
    expect(await restarted.of("s2")).toEqual({ unread: true });
    expect((await restarted.pinning()).projects).toEqual(
      new Map([["/work/pim", { pinned: true }]])
    );
  });

  test("clearing a flag leaves the others standing", async () => {
    const meta = new SessionMeta(file);
    await meta.setArchived("s1", true);
    await meta.setUnread("s1", true);
    await meta.setUnread("s1", false);

    const restarted = new SessionMeta(file);
    expect(await restarted.of("s1")).toEqual({ archived: true });
    await restarted.setArchived("s1", false);

    expect(await new SessionMeta(file).of("s1")).toEqual({});
  });

  test("the bulk read answers for every session at once", async () => {
    const meta = new SessionMeta(file);
    await meta.setArchived("s1", true);
    await meta.setUnread("s2", true);

    expect(await new SessionMeta(file).sessions()).toEqual(
      new Map([
        ["s1", { archived: true }],
        ["s2", { unread: true }],
      ])
    );
  });

  test("a file that will not parse is a file that is not there", async () => {
    await Bun.write(file, "{ not json");
    const meta = new SessionMeta(file);

    expect(await meta.of("s1")).toEqual({});
    expect(await meta.sessions()).toEqual(new Map());

    await meta.setArchived("s1", true);
    expect(await new SessionMeta(file).of("s1")).toEqual({ archived: true });
  });

  test("a version this build cannot read is not guessed at", async () => {
    await Bun.write(
      file,
      JSON.stringify({ version: 2, sessions: { s1: { archived: true } } })
    );

    expect(await new SessionMeta(file).of("s1")).toEqual({});
  });

  test("a malformed entry is dropped and its neighbours are kept", async () => {
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        sessions: {
          good: { archived: true },
          bad: { archived: "yes" },
          torn: 7,
        },
        projects: { "/good": { pinned: true }, "/bad": { pinned: 1 } },
      })
    );
    const meta = new SessionMeta(file);

    expect(await meta.sessions()).toEqual(
      new Map([["good", { archived: true }]])
    );
    expect((await meta.pinning()).projects).toEqual(
      new Map([["/good", { pinned: true }]])
    );
  });

  test("a new pin goes to the top and the order survives a restart", async () => {
    const meta = new SessionMeta(file);
    await meta.setPinned("/work/one", true);
    await meta.setPinned("/work/two", true);

    // Newest first: it goes where you have just put it, and it displaces
    // nothing that was already arranged.
    expect(await meta.pins()).toEqual(["/work/two", "/work/one"]);
    expect(await new SessionMeta(file).pins()).toEqual([
      "/work/two",
      "/work/one",
    ]);
  });

  test("an order outlives the moves that made it, and a pin that leaves it", async () => {
    const meta = new SessionMeta(file);
    await meta.setPinned("/work/one", true);
    await meta.setPinned("/work/two", true);
    await meta.setPinOrder(["/work/one", "/work/two"]);

    expect(await new SessionMeta(file).pins()).toEqual([
      "/work/one",
      "/work/two",
    ]);

    // Unpinned, it leaves the order with the flag; pinned again, it is new.
    await meta.setPinned("/work/one", false);
    expect(await meta.pins()).toEqual(["/work/two"]);
    await meta.setPinned("/work/one", true);
    expect(await meta.pins()).toEqual(["/work/one", "/work/two"]);
  });

  /**
   * The sidebar's fold is kept here rather than in a browser, so the group a
   * phone opened is the group a desktop opens to. Folded is where a project
   * starts, and a fold written back is the same as one never written: the
   * file stays the size of what somebody actually did to it.
   */
  test("a fold survives a restart, and folding again writes nothing down", async () => {
    const meta = new SessionMeta(file);
    await meta.setExpanded("/work/pim", true);

    expect((await new SessionMeta(file).pinning()).projects).toEqual(
      new Map([["/work/pim", { expanded: true }]])
    );

    await meta.setExpanded("/work/pim", false);
    expect((await new SessionMeta(file).pinning()).projects).toEqual(new Map());
  });

  /** A fold and a pin are two facts about one directory; neither may clear the other. */
  test("folding a project keeps its pin, and unpinning keeps its fold", async () => {
    const meta = new SessionMeta(file);
    await meta.setPinned("/work/pim", true);
    await meta.setExpanded("/work/pim", true);

    expect((await new SessionMeta(file).pinning()).projects).toEqual(
      new Map([["/work/pim", { pinned: true, expanded: true }]])
    );

    // Folded, it is still pinned, and still sorts where the pin put it.
    await meta.setExpanded("/work/pim", false);
    expect(await meta.pins()).toEqual(["/work/pim"]);

    // Unpinned, the fold it was left open at is still its own.
    await meta.setExpanded("/work/pim", true);
    await meta.setPinned("/work/pim", false);
    expect((await new SessionMeta(file).pinning()).projects).toEqual(
      new Map([["/work/pim", { expanded: true }]])
    );
    expect(await meta.pins()).toEqual([]);
  });

  test("the order is a hint over the flags, so it can say nothing true and cost nothing", async () => {
    // Written by a pim that predates the order, or by one that dropped it: two
    // pins and no word on where they sit.
    await Bun.write(
      file,
      JSON.stringify({
        version: 1,
        sessions: {},
        projects: { "/work/two": { pinned: true }, "/work/one": {} },
      })
    );
    const meta = new SessionMeta(file);
    await meta.setPinned("/work/one", true);

    // The pin it has heard of first, then the one it has not, by path.
    expect(await meta.pins()).toEqual(["/work/one", "/work/two"]);

    // And an order naming what is not pinned keeps only what is.
    await meta.setPinOrder(["/work/gone", "/work/two", "/work/one"]);
    expect(await new SessionMeta(file).pins()).toEqual([
      "/work/two",
      "/work/one",
    ]);
  });

  test("pruning forgets dead sessions and keeps every project", async () => {
    const meta = new SessionMeta(file);
    await meta.setArchived("kept", true);
    await meta.setUnread("deleted", true);
    await meta.setPinned("/work/pim", true);
    await meta.prune(new Set(["kept"]));

    const restarted = new SessionMeta(file);
    expect(await restarted.sessions()).toEqual(
      new Map([["kept", { archived: true }]])
    );
    expect((await restarted.pinning()).projects).toEqual(
      new Map([["/work/pim", { pinned: true }]])
    );
  });

  test("a write that cannot land rejects rather than passing for a save", async () => {
    const blocked = join(tmp, "blocked");
    await Bun.write(blocked, "not a directory");
    const meta = new SessionMeta(join(blocked, "sessions.json"));

    await expect(meta.setArchived("s1", true)).rejects.toThrow();
    // The failure must not poison the queue behind it.
    await expect(meta.setPinned("/work/pim", true)).rejects.toThrow();
  });

  test("concurrent mutations do not overwrite each other", async () => {
    const meta = new SessionMeta(file);

    await Promise.all([
      meta.setArchived("s1", true),
      meta.setUnread("s2", true),
      meta.setPinned("/work/pim", true),
    ]);

    const restarted = new SessionMeta(file);
    expect(await restarted.sessions()).toEqual(
      new Map([
        ["s1", { archived: true }],
        ["s2", { unread: true }],
      ])
    );
    expect((await restarted.pinning()).projects).toEqual(
      new Map([["/work/pim", { pinned: true }]])
    );
  });

  test("a write by another process survives the next mutation here", async () => {
    const meta = new SessionMeta(file);
    await meta.setArchived("mine", true);

    await new SessionMeta(file).setUnread("theirs", true);
    await meta.setPinned("/work/pim", true);
    await meta.flush();

    expect(await new SessionMeta(file).sessions()).toEqual(
      new Map([
        ["mine", { archived: true }],
        ["theirs", { unread: true }],
      ])
    );
  });
});
