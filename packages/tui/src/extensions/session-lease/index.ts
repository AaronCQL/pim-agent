import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { EventLog } from "#core/session/EventLog";
import {
  type LeaseHandle,
  type LeaseRecord,
  SessionLease,
} from "#core/session/SessionLease";
import { WriteMark } from "#core/session/WriteMark";

const POLL_MS = 2_000;

/** Survives the extension instance: `switchSession` re-runs every factory. */
let carried: { readonly path: string; readonly text: string } | undefined;

function isForeign(record: LeaseRecord | undefined): record is LeaseRecord {
  return record !== undefined && !SessionLease.isOurs(record);
}

function describe(record: LeaseRecord): string {
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

export default function (pi: ExtensionAPI): void {
  let manager: ExtensionContext["sessionManager"] | undefined;
  let path: string | undefined;
  let log: EventLog | undefined;
  let mark: WriteMark = WriteMark.UNREAD;
  let stale = false;
  let holder: LeaseRecord | undefined;
  let handle: LeaseHandle | undefined;
  let syncing = false;
  let stopWatch: (() => void) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const measure = async (): Promise<WriteMark | undefined> => {
    if (log === undefined || manager === undefined) {
      return undefined;
    }
    return await WriteMark.of(log, manager);
  };

  /** Absorb our own appends; anything else is another surface writing this session. */
  const reconcile = async (): Promise<void> => {
    const next = await measure();
    if (next === undefined) {
      return;
    }
    if (WriteMark.foreignSince(mark, next)) {
      stale = true;
      return;
    }
    mark = next;
  };

  /** Whatever the file says right now is the truth pi was opened on. */
  const anchor = async (): Promise<void> => {
    mark = (await measure()) ?? WriteMark.UNREAD;
    stale = false;
  };

  const refresh = async (): Promise<void> => {
    const current = path;
    if (current === undefined) {
      return;
    }
    holder = await SessionLease.read(current);
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

  // Idle only: during our own turn every append is ours and the lease is held.
  const startIdleWatch = (): void => {
    stopIdleWatch();
    const current = path;
    if (current === undefined) {
      return;
    }
    const tick = (): void => {
      void refresh().catch(() => undefined);
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
    notify(ctx, "This session was continued elsewhere — catching up.");
    if (!syncing) {
      syncing = true;
      // Deferred: dispatching inside `emitInput` tears the session down under its own stack.
      setTimeout(() => {
        pi.sendUserMessage("/sync", { expandPromptTemplates: true });
      }, 0);
    }
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
    notify(
      ctx,
      isForeign(result.holder)
        ? `${describe(result.holder)} just started a turn. Try again when it finishes.`
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
      const held = await SessionLease.read(current);
      if (isForeign(held)) {
        notify(
          ctx,
          `${describe(held)} is running a turn. Try /sync when it finishes.`
        );
        return;
      }
      try {
        // Reopening repairs a torn tail and rewrites on migration, so hold the lease over it.
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
