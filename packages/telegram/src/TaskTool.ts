import {
  defineTool,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";

import type { PimToolDefinition } from "#core/shared/Tools";
import type { Span, ToolView } from "#core/view/ViewBlock";
import type { SessionId } from "./Session";
import type { TaskScheduler } from "./TaskScheduler";
import { taskToolSchema, type TaskToolInput } from "./TaskSchema";

export type TaskToolDeps = {
  readonly scheduler: TaskScheduler;
  readonly sessionId: SessionId;
};

function build(deps: TaskToolDeps): PimToolDefinition<typeof taskToolSchema> {
  return {
    ...defineTool({
      name: "task",
      label: "task",
      description:
        "Manage scheduled/recurring tasks for this Telegram chat/thread.",
      parameters: taskToolSchema,
      async execute(_id, params) {
        const input = params as TaskToolInput;
        switch (input.action) {
          case "create":
            return await create(deps, input);
          case "list":
            return await list(deps);
          case "delete":
            return await deleteTask(deps, input);
          case "pause":
          case "resume":
            return await setStatus(deps, input);
          case "update_prompt":
            return await updatePrompt(deps, input);
        }
      },
    }),
    toViewModel: ({ args }): ToolView => ({
      label: "Task",
      icon: "clock",
      title: [
        {
          kind: "spans",
          spans: taskSpans((args ?? {}) as Partial<TaskToolInput>),
        },
      ],
    }),
  };
}

async function create(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.prompt) {
    throw new Error("'prompt' is required for action=create");
  }
  if (!input.schedule) {
    throw new Error("'schedule' is required for action=create");
  }
  const task = await deps.scheduler.create(deps.sessionId, {
    prompt: input.prompt,
    schedule: input.schedule,
    expires: input.expires,
    isolatedSession: input.isolatedSession,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `Created task ${task.id}. Next run: ${task.nextRun}.`,
      },
    ],
    details: task,
  };
}

async function list(deps: TaskToolDeps): Promise<AgentToolResult<unknown>> {
  const tasks = await deps.scheduler.list(deps.sessionId);
  if (tasks.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No tasks scheduled for this thread.",
        },
      ],
      details: { tasks: [] },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
    details: { tasks },
  };
}

async function deleteTask(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.id) {
    throw new Error("'id' is required for action=delete");
  }
  const ok = await deps.scheduler.delete(deps.sessionId, input.id);
  if (!ok) {
    throw new Error(`no task with id=${input.id} in this thread`);
  }
  return {
    content: [{ type: "text" as const, text: `Deleted task ${input.id}.` }],
    details: { id: input.id },
  };
}

async function setStatus(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.id) {
    throw new Error(`'id' is required for action=${input.action}`);
  }
  const target = input.action === "pause" ? "paused" : "active";
  const task = await deps.scheduler.setStatus(deps.sessionId, input.id, target);
  if (!task) {
    throw new Error(`no task with id=${input.id} in this thread`);
  }
  const text =
    input.action === "pause"
      ? `Paused task ${task.id}. Will not fire until resumed.`
      : `Resumed task ${task.id}. Next run: ${task.nextRun}.`;
  return {
    content: [{ type: "text" as const, text }],
    details: task,
  };
}

async function updatePrompt(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.id) {
    throw new Error("'id' is required for action=update_prompt");
  }
  if (!input.prompt) {
    throw new Error("'prompt' is required for action=update_prompt");
  }
  const task = await deps.scheduler.updatePrompt(
    deps.sessionId,
    input.id,
    input.prompt
  );
  if (!task) {
    throw new Error(`no task with id=${input.id} in this thread`);
  }
  return {
    content: [
      { type: "text" as const, text: `Updated prompt for task ${task.id}.` },
    ],
    details: task,
  };
}

/** Mirrors the schema's action union; a new action gets a bare verb, not a crash. */
function taskSpans(input: Partial<TaskToolInput>): readonly Span[] {
  const action = input.action;
  if (!action) {
    return [{ text: "..." }];
  }
  if (action === "list") {
    return [{ text: "List tasks" }];
  }
  if (action === "create") {
    const schedule = scheduleSummary(input);
    return [
      { text: "Schedule task" },
      ...(input.prompt ? [{ text: ": " }, code(input.prompt)] : []),
      ...(schedule ? [{ text: ` (${schedule})` }] : []),
    ];
  }
  if (action === "update_prompt") {
    return input.prompt
      ? [{ text: "Update task: " }, code(input.prompt)]
      : [{ text: "Update task" }];
  }
  const verb = VERBS[action] ?? action;
  return input.id
    ? [{ text: `${verb} task: ` }, code(input.id)]
    : [{ text: `${verb} task` }];
}

const VERBS: Readonly<Record<string, string>> = {
  delete: "Delete",
  pause: "Pause",
  resume: "Resume",
};

function code(text: string): Span {
  return { text, code: true };
}

function scheduleSummary(input: Partial<TaskToolInput>): string | undefined {
  const schedule = input.schedule;
  if (!schedule) {
    return undefined;
  }
  if (schedule.type === "once") {
    return `once @ ${schedule.at}`;
  }
  if (schedule.type === "interval") {
    return `every ${schedule.every}`;
  }
  return `cron ${schedule.expr}`;
}

export const TaskTool = { build };
