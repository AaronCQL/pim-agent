import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionEntry,
  SessionShutdownEvent,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  type TUI,
} from "@earendil-works/pi-tui";

import {
  JobMessage,
  type Placement,
} from "#core/extensions/subagent/JobMessage";
import type {
  JobDeliverer,
  JobDelivery,
  JobView,
  SubagentJobs,
} from "#core/extensions/subagent/SubagentJobs";
import { SubagentNotice } from "#core/extensions/subagent/SubagentNotice";
import { SubagentResult } from "#core/extensions/subagent/SubagentResult";
import { Errors } from "#core/shared/Errors";
import { Format } from "#core/shared/Format";
import { Timers, type Every } from "#core/shared/Timers";
import type { SessionGate } from "../session-lease/SessionGate";
import { JobsWidget } from "./JobsWidget";
import { SubagentNoticeRenderer } from "./SubagentNoticeRenderer";
import { SubagentResultRenderer } from "./SubagentResultRenderer";

export type SubagentJobsOptions = {
  readonly jobs: SubagentJobs;
  readonly gate: SessionGate;
  readonly now?: () => number;
  readonly every?: Every;
};

/** `stay`: the same session reopens. `leave`: another session replaces it. `quit`: the process ends. */
type Closing = "stay" | "leave" | "quit";

type OpenSession = {
  bashStarted(): void;
  runStarting(event: BeforeAgentStartEvent): void;
  runSettled(): void;
  close(closing: Closing): Promise<void>;
};

/**
 * A waking job message pi queued because it was settling a run. Pi sends its queue
 * in order once every settled handler has returned, and drops the rest of it
 * when one action throws. `answered` once a run starts with this message, or with
 * none of the queued ones: pi has then got past its queue.
 */
type Queued = {
  answered: boolean;
  readonly message: JobMessage;
  readonly over: () => void;
};

type Shared = {
  readonly jobs: SubagentJobs;
  readonly gate: SessionGate;
  readonly now: () => number;
  readonly every: Every;
};

const WIDGET_ID = "pim-subagent-jobs";
const TICK_MS = 1_000;

/** A press of the interrupt key; the Kitty protocol also reports its repeats and release. */
function isInterrupt(data: string): boolean {
  return (
    !isKeyRelease(data) &&
    !isKeyRepeat(data) &&
    getKeybindings().matches(data, "app.interrupt")
  );
}

/** The app's editor has focus, with no autocomplete menu, selector, dialog or overlay above it. */
function promptHasFocus(tui: TUI | undefined): boolean {
  const focused = (
    tui as { getFocusedComponent?: () => Component | null } | undefined
  )?.getFocusedComponent?.();
  return (
    focused !== undefined &&
    focused !== null &&
    "actionHandlers" in focused &&
    "isShowingAutocomplete" in focused &&
    typeof focused.isShowingAutocomplete === "function" &&
    focused.isShowingAutocomplete() === false
  );
}

function bashFinished(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" && entry.message.role === "bashExecution"
  );
}

/** `/sync` and `reload` reopen the session they close; `/new`, `/fork` and `/resume` elsewhere replace it. */
function closingFor(
  event: SessionShutdownEvent,
  ctx: ExtensionContext
): Closing {
  switch (event.reason) {
    case "quit":
      return "quit";
    case "reload":
      return "stay";
    case "resume":
      return event.targetSessionFile === ctx.sessionManager.getSessionFile()
        ? "stay"
        : "leave";
    case "new":
    case "fork":
      return "leave";
  }
}

function open(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  { jobs, gate, now, every }: Shared
): OpenSession {
  const id = ctx.sessionManager.getSessionId();
  let closed = false;
  let stopWaiting: (() => void) | undefined;
  let running = jobs.list(id);
  let tui: TUI | undefined;
  let stopTick: (() => void) | undefined;
  let stopping = false;
  /** Where the session stood when a `!command` began; unset once it is known to be over. */
  let bashFrom: number | undefined;
  /** By `JobMessage.key`. */
  const queued = new Map<string, Queued>();
  let shutting = false;
  const deliveries = new Set<Promise<Placement>>();

  const place = (message: JobMessage) =>
    JobMessage.placement(ctx.sessionManager, message);

  /** Resolves once a run that answers it settles, or the message lands, or the session closes. */
  const answered = (message: JobMessage): Promise<void> =>
    new Promise((over) => {
      if (shutting) {
        over();
      } else {
        queued.set(JobMessage.key(message)!, {
          answered: false,
          message,
          over,
        });
      }
    });

  const release = (key: string, wait: Queued): void => {
    queued.delete(key);
    wait.over();
  };

  const endQueued = (): void => {
    shutting = true;
    for (const [key, wait] of queued) {
      release(key, wait);
    }
  };

  const unwait = (): void => {
    stopWaiting?.();
    stopWaiting = undefined;
  };

  const retry = (): void => {
    unwait();
    jobs.flush(id);
  };

  /** Appends only while pi is idle and no other surface holds the session; a turn's boundary takes it otherwise. A waking message pi queued instead of starting its run is pi's until that queue is past. */
  const deliver = async (delivery: JobDelivery): Promise<Placement> => {
    if (closed || !ctx.isIdle()) {
      return "due";
    }
    const state = await gate.check();
    if (state === "held") {
      stopWaiting ??= gate.onChange(retry);
    }
    if (closed || state !== "open" || !ctx.isIdle()) {
      return "due";
    }
    const message = delivery.message;
    // Accepted race: a notice sent while the parent's run settles enters pi's deferred queue, past this check. If its job finishes in that window, the result queues behind it and the parent spends a turn on a stale "still running" notice; pi's queue cannot be retracted.
    if (!delivery.dropped && place(message) === "due") {
      pi.sendMessage<JobMessage["details"]>(message, {
        triggerTurn: delivery.wake,
      });
      if (ctx.isIdle() && place(message) === "due") {
        await answered(message);
      }
    }
    return place(message);
  };

  const track: JobDeliverer = (delivery) => {
    const outcome = deliver(delivery);
    const done = (): void => {
      deliveries.delete(outcome);
    };
    deliveries.add(outcome);
    outcome.then(done, done);
    return outcome;
  };

  const persist = async (): Promise<void> => {
    while (deliveries.size > 0) {
      await Promise.allSettled(deliveries);
    }
  };

  const stopTicking = (): void => {
    stopTick?.();
    stopTick = undefined;
  };

  const show = (list: readonly JobView[]): void => {
    running = list;
    if (list.length === 0) {
      stopTicking();
    } else {
      stopTick ??= every(TICK_MS, () => tui?.requestRender());
    }
    tui?.requestRender();
  };

  /** True for one Escape at most. */
  const bashRunning = (): boolean => {
    const from = bashFrom;
    bashFrom = undefined;
    return (
      from !== undefined &&
      !bashFinished(ctx.sessionManager.getEntries().slice(from))
    );
  };

  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void jobs
      .stopAll(id, { by: "user" })
      .then((count) => {
        if (!closed && count > 0) {
          ctx.ui.notify(
            `Stopped ${Format.count(count, "subagent job")}.`,
            "info"
          );
        }
      })
      .catch((err: unknown) => {
        if (!closed) {
          ctx.ui.notify(
            `Could not stop the subagent jobs: ${Errors.describe(err)}`,
            "error"
          );
        }
      })
      .finally(() => {
        stopping = false;
      });
  };

  /** While pi is busy the key still reaches it, so the turn (or compaction) ends too, and no held result wakes it again; idle, bash mode and a running `!command` keep it. */
  const onInput: TerminalInputHandler = (data) => {
    if (!isInterrupt(data) || !promptHasFocus(tui)) {
      return undefined;
    }
    if (!ctx.isIdle()) {
      if (running.length > 0 || jobs.hasPending(id)) {
        stop();
      }
      return undefined;
    }
    if (
      running.length === 0 ||
      bashRunning() ||
      ctx.ui.getEditorText().trimStart().startsWith("!")
    ) {
      return undefined;
    }
    stop();
    return { consume: true };
  };

  if (ctx.hasUI) {
    ctx.ui.setWidget(WIDGET_ID, (mounted, theme) => {
      tui = mounted;
      return {
        render: (width) => JobsWidget.lines(running, now(), theme, width),
        invalidate() {},
      };
    });
  }
  const detach = jobs.attach(id, track);
  const unsubscribe = jobs.subscribe(id, show);
  const stopInput = ctx.hasUI ? ctx.ui.onTerminalInput(onInput) : () => {};
  show(running);

  return {
    bashStarted() {
      bashFrom = ctx.sessionManager.getEntries().length;
    },
    runStarting(event) {
      const carried =
        event.messageType === "custom"
          ? JobMessage.key(event.message)
          : undefined;
      const carriesQueued = carried !== undefined && queued.has(carried);
      for (const [key, wait] of queued) {
        if (!carriesQueued || key === carried) {
          wait.answered = true;
        }
      }
    },
    runSettled() {
      for (const [key, wait] of queued) {
        if (wait.answered || place(wait.message) === "landed") {
          release(key, wait);
        }
      }
    },
    async close(closing) {
      endQueued();
      if (closing === "quit") {
        const stopped = jobs.stopEverything();
        if (!ctx.isIdle()) {
          ctx.abort();
        }
        await stopped;
      }
      if (closing === "leave") {
        await jobs.stopAll(id, { by: "user" });
        await persist();
      }
      closed = true;
      detach();
      unsubscribe();
      stopInput();
      unwait();
      stopTicking();
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
      }
    },
  };
}

/** Delivers background subagent results and notices into the session, shows running jobs, and stops them on Escape or when the session is left. */
export default function subagentJobs(
  options: SubagentJobsOptions
): ExtensionFactory {
  const shared: Shared = {
    jobs: options.jobs,
    gate: options.gate,
    now: options.now ?? Date.now,
    every: options.every ?? Timers.every,
  };
  return (pi) => {
    let session: OpenSession | undefined;

    pi.registerMessageRenderer(
      SubagentResult.CUSTOM_TYPE,
      SubagentResultRenderer.render
    );
    pi.registerMessageRenderer(
      SubagentNotice.CUSTOM_TYPE,
      SubagentNoticeRenderer.render
    );

    pi.on("session_start", (_event, ctx) => {
      session = open(pi, ctx, shared);
    });

    pi.on("user_bash", () => {
      session?.bashStarted();
    });

    pi.on("before_agent_start", (event) => {
      session?.runStarting(event);
    });

    pi.on("agent_settled", () => {
      session?.runSettled();
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const closing = session;
      session = undefined;
      await closing?.close(closingFor(event, ctx));
    });
  };
}
