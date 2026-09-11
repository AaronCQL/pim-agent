import {
  defineTool,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";

import type { PimToolDefinition } from "#core/shared/Tools";
import type { Span, ToolView } from "#core/view/ViewBlock";
import type { SessionId } from "./Session";
import type { TaskScheduler } from "./TaskScheduler";
import {
  taskToolSchema,
  type ScheduledTask,
  type TaskToolInput,
} from "./TaskSchema";

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
  const prompt = required(input, "prompt");
  const schedule = required(input, "schedule");
  const task = await deps.scheduler.create(deps.sessionId, {
    prompt,
    schedule,
    expires: input.expires,
    isolatedSession: input.isolatedSession,
  });
  return text(`Created task ${task.id}. Next run: ${task.nextRun}.`, task);
}

async function list(deps: TaskToolDeps): Promise<AgentToolResult<unknown>> {
  const tasks = await deps.scheduler.list(deps.sessionId);
  return tasks.length === 0
    ? text("No tasks scheduled for this thread.", { tasks: [] })
    : text(JSON.stringify(tasks), { tasks });
}

async function deleteTask(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  const id = required(input, "id");
  const ok = await deps.scheduler.delete(deps.sessionId, id);
  if (!ok) {
    throw notFound(id);
  }
  return text(`Deleted task ${id}.`, { id });
}

async function setStatus(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  const id = required(input, "id");
  const paused = input.action === "pause";
  const task = found(
    await deps.scheduler.setStatus(
      deps.sessionId,
      id,
      paused ? "paused" : "active"
    ),
    id
  );
  return text(
    paused
      ? `Paused task ${task.id}. Will not fire until resumed.`
      : `Resumed task ${task.id}. Next run: ${task.nextRun}.`,
    task
  );
}

async function updatePrompt(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  const id = required(input, "id");
  const prompt = required(input, "prompt");
  const task = found(
    await deps.scheduler.updatePrompt(deps.sessionId, id, prompt),
    id
  );
  return text(`Updated prompt for task ${task.id}.`, task);
}

function text(message: string, details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: message }],
    details,
  };
}

function required<K extends "id" | "prompt" | "schedule">(
  input: TaskToolInput,
  field: K
): NonNullable<TaskToolInput[K]> {
  const value = input[field];
  if (!value) {
    throw new Error(`'${field}' is required for action=${input.action}`);
  }
  return value;
}

function found(task: ScheduledTask | undefined, id: string): ScheduledTask {
  if (!task) {
    throw notFound(id);
  }
  return task;
}

function notFound(id: string): Error {
  return new Error(`no task with id=${id} in this thread`);
}

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
