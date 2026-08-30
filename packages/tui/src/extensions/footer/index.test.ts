import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFooterWidget, getTotalCost } from "./index";
import type { GitState } from "./git";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function assistant(cost: number): unknown {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        cost: {
          total: cost,
        },
      },
    },
  };
}

describe("getTotalCost", () => {
  test("sums assistant costs across all session entries", () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          assistant(1.25),
          {
            type: "message",
            message: {
              role: "user",
            },
          },
          assistant(2.5),
        ],
      },
    } as unknown as ExtensionContext;

    expect(getTotalCost(ctx)).toBe(3.75);
  });
});

describe("createFooterWidget", () => {
  test("coalesces git refreshes while one is in flight", async () => {
    const first = deferred<GitState>();
    const second = deferred<GitState>();
    const fetches: Promise<GitState>[] = [];
    let branchHandler: () => void = () => {};
    let gitWatchHandler: () => void = () => {};
    let branchUnsubscribed = false;
    let gitWatchDisposed = false;
    let renderRequests = 0;

    const ctx = {
      cwd: "/repo",
      sessionManager: {
        getEntries: () => [],
      },
    } as unknown as ExtensionContext;

    const widget = createFooterWidget(
      ctx,
      {
        requestRender: () => {
          renderRequests++;
        },
      },
      {
        onBranchChange: (handler) => {
          branchHandler = handler;
          return () => {
            branchUnsubscribed = true;
          };
        },
      },
      {
        fetchGitStatus: () => {
          const promise = fetches.length === 0 ? first.promise : second.promise;
          fetches.push(promise);
          return promise;
        },
        watchGitDir: (_cwd, handler) => {
          gitWatchHandler = handler;
          return () => {
            gitWatchDisposed = true;
          };
        },
        renderFooterLine: (_width, _ctx, gitState) => gitState.branch ?? "none",
        getTotalCost: () => 0,
      }
    );

    expect(fetches).toHaveLength(1);

    branchHandler();
    gitWatchHandler();
    expect(fetches).toHaveLength(1);

    first.resolve({ branch: "main", dirty: false, ahead: 0, behind: 0 });
    await flushPromises();
    expect(fetches).toHaveLength(2);

    second.resolve({ branch: "next", dirty: true, ahead: 1, behind: 0 });
    await flushPromises();
    expect(fetches).toHaveLength(2);
    expect(renderRequests).toBe(2);
    expect(widget.render(80)).toEqual(["next"]);

    widget.dispose();
    expect(branchUnsubscribed).toBe(true);
    expect(gitWatchDisposed).toBe(true);
  });

  test("requests render only when git state changes", async () => {
    const refresh = deferred<GitState>();
    let renderRequests = 0;

    const widget = createFooterWidget(
      {
        cwd: "/repo",
        sessionManager: {
          getEntries: () => [],
        },
      } as unknown as ExtensionContext,
      {
        requestRender: () => {
          renderRequests++;
        },
      },
      {
        onBranchChange: () => () => {},
      },
      {
        fetchGitStatus: () => refresh.promise,
        watchGitDir: () => () => {},
        renderFooterLine: () => "",
        getTotalCost: () => 0,
      }
    );

    refresh.resolve({ branch: null, dirty: false, ahead: 0, behind: 0 });
    await flushPromises();

    expect(renderRequests).toBe(0);
    widget.dispose();
  });
});
