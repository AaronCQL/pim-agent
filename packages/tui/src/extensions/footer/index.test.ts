import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFooterWidget, getTotalCost } from "./index";
import { Git, type GitState } from "#core/shared/Git";
import { GitMonitor } from "#core/shared/GitMonitor";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
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
  const ctx = {
    cwd: "/repo",
    sessionManager: {
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;

  test("repaints the footer as the repository moves under it", async () => {
    let branch: GitState = {
      branch: "main",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    };
    const monitor = new GitMonitor({ status: () => Promise.resolve(branch) });
    let renderRequests = 0;

    const widget = createFooterWidget(
      ctx,
      {
        requestRender: () => {
          renderRequests++;
        },
      },
      { onBranchChange: () => () => {} },
      monitor,
      {
        renderFooterLine: (_width, _context, state) => state.branch ?? "none",
        getTotalCost: () => 0,
      }
    );
    await flushPromises();

    expect(widget.render(80)).toEqual(["main"]);
    expect(renderRequests).toBe(1);

    branch = { branch: "next", dirtyCount: 1, ahead: 1, behind: 0 };
    await monitor.refresh("/repo");

    expect(widget.render(80)).toEqual(["next"]);
    expect(renderRequests).toBe(2);

    widget.dispose();
    await monitor.refresh("/repo");
    expect(renderRequests).toBe(2);
  });

  test("drops its branch subscription when disposed", async () => {
    let unsubscribed = false;
    const widget = createFooterWidget(
      ctx,
      { requestRender: () => {} },
      {
        onBranchChange: () => () => {
          unsubscribed = true;
        },
      },
      new GitMonitor({ status: () => Promise.resolve(Git.EMPTY) }),
      { renderFooterLine: () => "", getTotalCost: () => 0 }
    );
    await flushPromises();

    widget.dispose();
    expect(unsubscribed).toBe(true);
  });
});
