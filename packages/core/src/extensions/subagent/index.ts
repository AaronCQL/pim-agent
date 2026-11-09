import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BoundaryResult,
  BoundaryState,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { Format } from "../../shared/Format";
import { Json } from "../../shared/Json";
import { SubagentLogs } from "../../shared/SubagentLogs";
import { Tools } from "../../shared/Tools";
import { subagentView } from "./render";
import {
  subagentSchema,
  syncSubagentSchema,
  type SubagentInput,
  type SubagentToolDetails,
} from "./schema";
import { JobLine } from "./JobLine";
import { LongCache } from "./LongCache";
import type { JobView, SubagentJobs } from "./SubagentJobs";
import { SubagentReconcile } from "./SubagentReconcile";
import { SubagentResult } from "./SubagentResult";
import {
  runSubagent,
  startSubagent,
  subagentParent,
  type CreateSubagentSession,
  type SubagentDetails,
} from "./subagent";

export type SubagentOptions = {
  /** Omit to run every spawn synchronously, as in print mode. */
  readonly jobs?: SubagentJobs;
  /** Defaults to a pi SDK session. */
  readonly createSession?: CreateSubagentSession;
};

type Result = AgentToolResult<SubagentToolDetails>;

type ParentSession = ExtensionContext["sessionManager"];

const SHARED =
  "Subagents inherit the current model, thinking level and active tools, except subagent; output is capped at 32KB.";

const SYNC_DESCRIPTION =
  "Run a task in an isolated subagent with a fresh context and return its answer. " +
  "Multiple calls in one turn run in parallel. " +
  SHARED;

const ASYNC_DESCRIPTION =
  "Run tasks in background subagents, each with a fresh context. " +
  "A spawn returns a handle (j1) at once; its result arrives later as a subagent_result message that wakes you. " +
  SHARED;

function text(value: string): Result["content"] {
  return [{ type: "text", text: value }];
}

function need(
  action: string,
  field: string,
  what: string,
  example: string
): never {
  throw new Error(
    `subagent action="${action}" needs "${field}": ${what}. Example: ${example}`
  );
}

function prepareArguments(args: unknown): SubagentInput {
  const record = Json.asRecord(args);
  return (
    record !== undefined && record["action"] === undefined && "prompt" in record
      ? { ...record, action: "spawn" }
      : args
  ) as SubagentInput;
}

function list(jobs: readonly JobView[], now: number): string {
  return jobs.length === 0
    ? "No subagent jobs are running."
    : [
        `${Format.count(jobs.length, "subagent job")} running:`,
        ...jobs.map((job) => JobLine.text(job, now)),
      ].join("\n");
}

function status(
  jobs: SubagentJobs,
  parentSessionId: string,
  input: SubagentInput
): Result {
  if (input.id === undefined) {
    const found = jobs.list(parentSessionId);
    return {
      content: text(list(found, jobs.now())),
      details: { action: "status", jobs: found },
    };
  }
  const job = jobs.resolve(parentSessionId, input.id);
  return {
    content: text(jobs.peek(parentSessionId, input.id)),
    details: { action: "status", jobs: [job], id: input.id },
  };
}

async function stop(
  jobs: SubagentJobs,
  parentSessionId: string,
  input: SubagentInput
): Promise<Result> {
  const target = input.id;
  if (target === undefined) {
    need(
      "stop",
      "id",
      "the job to stop",
      '{"action":"stop","id":"j1","reason":"no longer needed"}'
    );
  }
  if (input.reason === undefined) {
    need(
      "stop",
      "reason",
      "why you are stopping it, in a few words",
      `{"action":"stop","id":"${target}","reason":"no longer needed"}`
    );
  }
  const result = await jobs.stop(parentSessionId, target, {
    by: "agent",
    reason: input.reason,
  });
  return {
    content: text(
      `Stopped ${result.details.handle} (${input.reason}); its result follows.`
    ),
    details: {
      action: "stop",
      jobIds: [result.details.jobId],
      reason: input.reason,
    },
  };
}

async function steer(
  jobs: SubagentJobs,
  parentSessionId: string,
  input: SubagentInput
): Promise<Result> {
  if (input.id === undefined) {
    need(
      "steer",
      "id",
      "the job to steer",
      '{"action":"steer","id":"j1","message":"..."}'
    );
  }
  if (input.message === undefined) {
    need(
      "steer",
      "message",
      "what to tell the job",
      `{"action":"steer","id":"${input.id}","message":"..."}`
    );
  }
  const job = await jobs.steer(parentSessionId, input.id, input.message);
  return {
    content: text(
      `Sent to job ${job.handle}; it reads it before its next step.`
    ),
    details: { action: "steer", jobId: job.id, message: input.message },
  };
}

/** A turn boundary appends the held results that are not on the branch yet, and continues the run if one wakes. */
function boundary(
  jobs: SubagentJobs,
  event: BoundaryState,
  session: ParentSession
): BoundaryResult | undefined {
  if (event.outcome !== "completed") {
    return undefined;
  }
  const due = jobs.due(session.getSessionId(), (jobId) =>
    SubagentResult.placement(session, jobId)
  );
  if (due.length === 0) {
    return undefined;
  }
  return {
    entries: [
      ...event.entries,
      ...due.map(({ result }) => ({
        type: "custom_message" as const,
        customType: result.customType,
        content: result.content,
        display: result.display,
        details: result.details,
      })),
    ],
    ...(due.some((delivery) => delivery.wake) ? { continue: true } : {}),
  };
}

export default function (options: SubagentOptions = {}): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    SubagentLogs.installSweeper();
    const jobs = options.jobs;

    const spawn = async (
      callId: string,
      input: SubagentInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
      ctx: ExtensionContext
    ): Promise<Result> => {
      const prompt = input.prompt;
      if (prompt === undefined) {
        need(
          "spawn",
          "prompt",
          "the complete, self-contained task",
          '{"action":"spawn","prompt":"Find every caller of parseConfig and say which are tests"}'
        );
      }
      const run = {
        callId,
        activeToolNames: pi.getActiveTools(),
        thinkingLevel: pi.getThinkingLevel(),
        ...(options.createSession === undefined
          ? {}
          : { createSession: options.createSession }),
      };
      const parent = subagentParent(ctx);
      if (jobs === undefined) {
        return await runSubagent(prompt, parent, { ...run, signal, onUpdate });
      }
      const job = jobs.spawn(ctx.sessionManager.getSessionId(), {
        callId,
        prompt,
        lastHandle: SubagentReconcile.lastHandle(
          ctx.sessionManager.getEntries()
        ),
        start: (onChange) =>
          startSubagent(prompt, parent, { ...run, onChange }),
      });
      return {
        content: text(
          `Started job ${job.handle}. You will be woken with its result; end your turn if you have nothing else to do.`
        ),
        details: {
          action: "spawn",
          jobId: callId,
          handle: job.handle,
          prompt,
          owner: SubagentReconcile.owner(),
        },
      };
    };

    Tools.register<typeof subagentSchema, SubagentToolDetails>(pi, {
      name: "subagent",
      label: "subagent",
      ...(jobs === undefined
        ? {
            description: SYNC_DESCRIPTION,
            // The sync input is SubagentInput minus `action`; execute dispatches on `jobs`.
            parameters: syncSubagentSchema as unknown as typeof subagentSchema,
          }
        : {
            description: ASYNC_DESCRIPTION,
            parameters: subagentSchema,
            prepareArguments,
          }),
      renderShell: "self",
      effect: { kind: "unbounded" },
      executionMode: "parallel",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const input = params as SubagentInput;
        if (jobs === undefined || input.action === "spawn") {
          return await spawn(toolCallId, input, signal, onUpdate, ctx);
        }
        const parentSessionId = ctx.sessionManager.getSessionId();
        switch (input.action) {
          case "status":
            return status(jobs, parentSessionId, input);
          case "stop":
            return await stop(jobs, parentSessionId, input);
          case "steer":
            return await steer(jobs, parentSessionId, input);
        }
      },
      toViewModel: subagentView,
    });

    if (jobs === undefined) {
      return;
    }

    let reconciling = Promise.resolve();
    const reconcile = (session: ParentSession): Promise<void> => {
      reconciling = reconciling
        .then(() => SubagentReconcile.run(jobs, session))
        .catch((err: unknown) => {
          console.warn("[subagent] reconcile failed:", err);
        });
      return reconciling;
    };

    /** Reconciles, then retries the held results, a macrotask after the event. */
    const retry = (_event: unknown, ctx: ExtensionContext): void => {
      const session = ctx.sessionManager;
      setTimeout(() => {
        void reconcile(session).then(() => jobs.flush(session.getSessionId()));
      }, 0);
    };

    pi.on("session_start", async (_event, ctx) => {
      await reconcile(ctx.sessionManager);
    });
    pi.on("turn_end", (event, ctx) =>
      boundary(jobs, event, ctx.sessionManager)
    );
    pi.on("agent_before_settle", (event, ctx) =>
      boundary(jobs, event, ctx.sessionManager)
    );
    pi.on("before_provider_request", (event, ctx) =>
      ctx.model !== undefined &&
      LongCache.supports(ctx.model) &&
      jobs.hasRunning(ctx.sessionManager.getSessionId())
        ? LongCache.extend(event.payload)
        : undefined
    );
    pi.on("agent_settled", retry);
    pi.on("session_compact", retry);
    pi.on("session_compact_failed", retry);
    pi.on("session_tree", retry);
  };
}
