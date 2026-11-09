import type {
  ExtensionAPI,
  ExtensionFactory,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  startParent,
  type Parent,
  type Script,
} from "#core/extensions/subagent/fixtures/parent";
import { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import { usePimHome } from "#core/shared/fixtures/home";
import { until } from "#core/shared/fixtures/wait";
import { SessionGate } from "../session-lease/SessionGate";
import subagentJobs from "./index";

usePimHome("pim-subagent-delivery-");

let parents: Parent[] = [];

afterEach(async () => {
  await Promise.all(parents.map((parent) => parent.dispose()));
  parents = [];
});

type Setup = {
  readonly script?: Script;
  readonly gate?: SessionGate;
  readonly extensions?: readonly ExtensionFactory[];
  readonly settings?: Record<string, unknown>;
  readonly jobs?: SubagentJobs;
};

/** A real pi session with the core subagent extension and this one; the model spawns one job per name, then answers "ok". */
async function start(spawn: readonly string[], setup: Setup = {}) {
  const jobs = setup.jobs ?? new SubagentJobs();
  const parent = await startParent({
    jobs,
    script:
      setup.script ??
      ((_request, index) => (index === 0 ? { spawn } : { text: "ok" })),
    extensions: [
      subagentJobs({ jobs, gate: setup.gate ?? new SessionGate() }),
      ...(setup.extensions ?? []),
    ],
    ...(setup.settings === undefined ? {} : { settings: setup.settings }),
  });
  parents.push(parent);
  const { session } = parent;
  const id = session.sessionId;
  return {
    ...parent,
    jobs,
    id,
    /** Ends every job, once all of them have started. */
    async finish(): Promise<void> {
      await until(
        () =>
          parent.children.size === spawn.length &&
          [...parent.children.values()].every((child) => child.promptCalls),
        "the jobs to start"
      );
      for (const child of parent.children.values()) {
        child.finish("found it");
      }
      await until(() => !jobs.hasRunning(id), "the jobs to finish");
    },
    settled: () =>
      until(
        () => session.isIdle && !jobs.hasPending(id),
        "every result to land and the agent to settle"
      ),
  };
}

function entryId(
  entries: readonly SessionEntry[],
  match: (entry: SessionEntry) => boolean
): string {
  return entries.find(match)!.id;
}

const isSpawn = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "toolResult";

const isUser = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "user";

describe("a result", () => {
  test("that finishes while idle lands and wakes the agent once", async () => {
    const parent = await start(["c1"]);
    await parent.session.prompt("go");

    await parent.finish();
    await parent.settled();

    expect(parent.results("c1")).toMatchObject([{ state: "done" }]);
    expect(parent.requests).toHaveLength(3);
    expect(JSON.stringify(parent.requests[2]?.messages)).toContain(
      "[subagent job j1 done]"
    );
  });

  test("that finishes mid-turn lands at the turn's end and continues it", async () => {
    let parent!: Awaited<ReturnType<typeof start>>;
    parent = await start(["c1"], {
      script: async (_request, index) => {
        if (index === 0) {
          return { spawn: ["c1"] };
        }
        if (index === 1) {
          await parent.finish();
        }
        return { text: "ok" };
      },
    });

    await parent.session.prompt("go");
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(parent.requests).toHaveLength(3);
  });
});

describe("results that finish before a request fails", () => {
  /** The model spawns c1 and c2; both end before its next request, which fails. */
  function failing(parent: () => Awaited<ReturnType<typeof start>>): Script {
    return async (_request, index) => {
      if (index === 0) {
        return { spawn: ["c1", "c2"] };
      }
      if (index === 1) {
        await parent().finish();
        return { status: 400 };
      }
      return { text: "ok" };
    };
  }

  test("land once each, the second at the boundary of the run the first wakes", async () => {
    let parent!: Awaited<ReturnType<typeof start>>;
    parent = await start(["c1", "c2"], { script: failing(() => parent) });

    await parent.session.prompt("go");
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(parent.results("c2")).toHaveLength(1);
    expect(parent.requests).toHaveLength(4);
    expect(parent.errors).toEqual([]);
  });

  test("land once each when every settling run outlasts the retry", async () => {
    let flushes = (): number => 0;
    const slowSettle: ExtensionFactory = (pi) => {
      pi.on("agent_settled", async () => {
        const seen = flushes();
        await until(() => flushes() > seen, "the retry");
      });
    };
    let parent!: Awaited<ReturnType<typeof start>>;
    parent = await start(["c1", "c2"], {
      script: failing(() => parent),
      extensions: [slowSettle],
    });
    const flush = spyOn(parent.jobs, "flush");
    flushes = () => flush.mock.calls.length;

    await parent.session.prompt("go");
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(parent.results("c2")).toHaveLength(1);
    expect(parent.errors).toEqual([]);
  });
});

describe("a waking result pi queues while it settles a run", () => {
  test("still lands once pi drops its queue", async () => {
    const compacting = Promise.withResolvers<void>();
    const compacted = Promise.withResolvers<void>();
    let whileSettling: ((pi: ExtensionAPI) => Promise<void>) | undefined;
    const hooks: ExtensionFactory = (pi) => {
      pi.on("agent_settled", async () => {
        const run = whileSettling;
        whileSettling = undefined;
        await run?.(pi);
      });
      pi.on("session_before_compact", async () => {
        compacting.resolve();
        await compacted.promise;
        return { cancel: true };
      });
    };
    const parent = await start(["c1"], {
      extensions: [hooks],
      settings: { compaction: { keepRecentTokens: 1 } },
    });
    await parent.session.prompt("go");
    const sends = spyOn(parent.session, "sendCustomMessage");
    let compaction: Promise<unknown> = Promise.resolve();
    whileSettling = async (pi) => {
      pi.sendUserMessage("typed while settling");
      await parent.finish();
      await until(() => sends.mock.calls.length > 0, "the waking send");
      compaction = parent.session.compact().catch(() => undefined);
      await compacting.promise;
    };

    await expect(parent.session.prompt("second")).rejects.toThrow(
      "compaction is in progress"
    );
    compacted.resolve();
    await compaction;
    await parent.session.prompt("third");
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
  });
});

describe("a result that finishes while pi is busy outside a run", () => {
  test("lands, and wakes the agent, once the branch summary is done", async () => {
    const summarizing = Promise.withResolvers<void>();
    const summarized = Promise.withResolvers<void>();
    const holdSummary: ExtensionFactory = (pi) => {
      pi.on("session_before_tree", async () => {
        summarizing.resolve();
        await summarized.promise;
        return { summary: { summary: "the abandoned branch" } };
      });
    };
    const parent = await start(["c1"], { extensions: [holdSummary] });
    await parent.session.prompt("go");
    const sm = parent.session.sessionManager;

    const navigating = parent.session.navigateTree(
      entryId(sm.getBranch(), isSpawn),
      { summarize: true }
    );
    await summarizing.promise;
    await parent.finish();
    summarized.resolve();
    await navigating;
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(parent.requests).toHaveLength(3);
  });

  test.each([
    ["compaction", true],
    ["cancelled compaction", false],
  ])("lands, and wakes the agent, once a manual %s ends", async (_case, ok) => {
    const compacting = Promise.withResolvers<void>();
    const compacted = Promise.withResolvers<void>();
    const holdCompaction: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", async (event) => {
        compacting.resolve();
        await compacted.promise;
        return ok
          ? {
              compaction: {
                summary: "earlier work",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            }
          : { cancel: true };
      });
    };
    const parent = await start(["c1"], {
      extensions: [holdCompaction],
      settings: { compaction: { keepRecentTokens: 1 } },
    });
    await parent.session.prompt("go");

    const compaction = parent.session.compact().catch(() => undefined);
    await compacting.promise;
    await parent.finish();
    compacted.resolve();
    await compaction;
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(parent.requests).toHaveLength(3);
  });
});

describe("a result whose spawn is on another branch", () => {
  test("waits for that branch, then lands on it once", async () => {
    const parent = await start(["c1"]);
    await parent.session.prompt("go");
    const sm = parent.session.sessionManager;
    const home = sm.getLeafId()!;

    await parent.session.navigateTree(entryId(sm.getBranch(), isUser));
    await parent.finish();

    expect(parent.results("c1")).toEqual([]);
    expect(parent.jobs.hasPending(parent.id)).toBe(true);

    await parent.session.navigateTree(home);
    await parent.settled();

    expect(parent.results("c1")).toHaveLength(1);
    expect(
      sm.getBranch().filter((entry) => entry.type === "custom_message")
    ).toHaveLength(1);
    expect(parent.requests).toHaveLength(3);
  });

  test("keeps neither shutdown nor the session waiting for it", async () => {
    const parent = await start(["c1"], {
      jobs: new SubagentJobs({ grace: () => new Promise(() => {}) }),
    });
    await parent.session.prompt("go");
    const sm = parent.session.sessionManager;

    await parent.session.navigateTree(entryId(sm.getBranch(), isUser));
    await parent.finish();
    await parent.jobs.stopEverything();

    expect(parent.jobs.hasPending(parent.id)).toBe(true);
    expect(parent.jobs.hasDue(parent.id)).toBe(false);
  });
});
