import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { EventLog } from "#core/session/EventLog";
import {
  type LeaseHandle,
  type LeaseHolder,
  SessionLease,
} from "#core/session/SessionLease";
import { WriteMark } from "#core/session/WriteMark";
import type { SessionGate } from "./SessionGate";

const POLL_MS = 2_000;

/** Module-level because `switchSession` re-runs every factory. */
let carried: { readonly path: string; readonly text: string } | undefined;

function isForeign(holder: LeaseHolder | undefined): holder is LeaseHolder {
  return holder !== undefined && !SessionLease.isOurs(holder.record);
}

function describe({ record }: LeaseHolder): string {
  if (record === undefined) {
    return "Another surface";
  }
  return record.frontend === "daemon" ? "The browser" : "Another terminal";
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "warning"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

export type SessionLeaseOptions = {
  readonly gate?: SessionGate;
};

export default function sessionLease(
  options: SessionLeaseOptions = {}
): ExtensionFactory {
  return (pi) => register(pi, options);
}

function register(pi: ExtensionAPI, { gate }: SessionLeaseOptions): void {
  let manager: ExtensionContext["sessionManager"] | undefined;
  let path: string | undefined;
  let log: EventLog | undefined;
  let mark: WriteMark = WriteMark.UNREAD;
  let stale = false;
  let holder: LeaseHolder | undefined;
  let handle: LeaseHandle | undefined;
  let syncing = false;
  let closing = false;
  let stopWatch: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  /** Marks the session stale when another surface wrote it. Only `anchor()` clears staleness. */
  const reconcile = async (): Promise<void> => {
    const current = log;
    if (stale || current === undefined || manager === undefined) {
      return;
    }
    const { next, foreign } = await WriteMark.scan(current, mark, manager);
    if (current !== log) {
      return;
    }
    if (foreign) {
      stale = true;
    } else {
      mark = next;
    }
  };

  const anchor = async (): Promise<void> => {
    const current = log;
    const next =
      current === undefined ? WriteMark.UNREAD : await WriteMark.at(current);
    if (current === log) {
      mark = next;
      stale = false;
    }
  };

  const refresh = async (): Promise<void> => {
    const current = path;
    if (current === undefined) {
      return;
    }
    holder = await SessionLease.holder(current);
    await reconcile();
  };

  const stopIdleWatch = (): void => {
    stopWatch?.();
    stopWatch = undefined;
    if (poll !== undefined) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  // Idle only: during our own turn we hold the lease.
  const startIdleWatch = (): void => {
    stopIdleWatch();
    const current = path;
    if (current === undefined) {
      return;
    }
    const tick = (): void => {
      void refresh()
        .then(() => gate?.changed())
        .catch(() => undefined);
    };
    stopWatch = SessionLease.watch(current, tick);
    poll = setInterval(tick, POLL_MS);
    poll.unref?.();
  };

  const pointAt = (next: string | undefined): void => {
    path = next;
    log = next === undefined ? undefined : new EventLog(next);
    mark = WriteMark.UNREAD;
    stale = false;
    holder = undefined;
  };

  const catchUp = (ctx: ExtensionContext): void => {
    notify(ctx, "This session was continued elsewhere — catching up.");
    if (syncing) {
      return;
    }
    syncing = true;
    // Deferred: dispatching inside `emitInput` tears the session down under its own stack.
    setTimeout(() => {
      pi.sendUserMessage("/sync", { expandPromptTemplates: true });
    }, 0);
  };

  const release = async (): Promise<void> => {
    const held = handle;
    handle = undefined;
    await held?.release();
  };

  pi.on("session_start", async (_event, ctx) => {
    manager = ctx.sessionManager;
    handle = undefined;
    syncing = false;
    pointAt(ctx.sessionManager.getSessionFile());
    await anchor();
    startIdleWatch();
    gate?.bind(async () => {
      await refresh();
      if (isForeign(holder)) {
        return "held";
      }
      if (stale) {
        if (!closing) {
          catchUp(ctx);
        }
        return "stale";
      }
      return "open";
    });

    const stash = carried;
    carried = undefined;
    if (stash !== undefined && stash.path === path) {
      notify(ctx, `Caught up — your message was not sent: ${stash.text}`);
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined || path === undefined) {
      return { action: "continue" };
    }
    await refresh();

    if (isForeign(holder)) {
      notify(
        ctx,
        `${describe(holder)} is running a turn. Try again when it finishes.`
      );
      return { action: "handled" };
    }
    if (!stale) {
      return { action: "continue" };
    }

    if (event.text.trim() !== "") {
      carried = { path, text: event.text };
    }
    catchUp(ctx);
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    stopIdleWatch();
    const current = path;
    if (current === undefined || handle !== undefined) {
      return;
    }
    const result = await SessionLease.acquire(current, "tui");
    if (result.ok) {
      handle = result.handle;
      return;
    }
    const by: LeaseHolder = { record: result.holder };
    notify(
      ctx,
      isForeign(by)
        ? `${describe(by)} just started a turn. Try again when it finishes.`
        : "This session's turn lease is held elsewhere. Try again in a moment."
    );
    ctx.abort();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await release();
    manager = ctx.sessionManager;
    const file = ctx.sessionManager.getSessionFile();
    if (file !== path) {
      pointAt(file);
    }
    await reconcile();
    startIdleWatch();
  });

  pi.on("session_shutdown", async () => {
    closing = true;
    stopIdleWatch();
    await release();
  });

  pi.registerCommand("sync", {
    description: "Reload this session from disk after another surface wrote it",
    handler: async (_args, ctx) => {
      syncing = false;
      const current = path;
      if (current === undefined) {
        notify(ctx, "This session is not on disk yet — nothing to sync.");
        return;
      }
      if (!ctx.isIdle()) {
        notify(ctx, "Wait for the current turn to finish, then run /sync.");
        return;
      }
      // A missing or unreadable file makes pi's session replacement exit the process.
      if (!(await Bun.file(current).exists())) {
        notify(ctx, `Session file is gone: ${current}`, "error");
        return;
      }
      const held = await SessionLease.holder(current);
      if (isForeign(held)) {
        notify(
          ctx,
          `${describe(held)} is running a turn. Try /sync when it finishes.`
        );
        return;
      }
      try {
        // Reopening may rewrite the file, so hold the lease.
        await SessionLease.hold(
          current,
          "tui",
          async () => {
            const result = await ctx.switchSession(current);
            if (result.cancelled) {
              notify(ctx, "Sync cancelled.");
            }
          },
          { timeoutMs: 0 }
        );
      } catch (err) {
        notify(ctx, err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
