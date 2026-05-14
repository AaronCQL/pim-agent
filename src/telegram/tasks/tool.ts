import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { ThreadHandle } from "../SessionRegistry";
import type { Scheduler } from "./Scheduler";
import { taskToolSchema, type TaskToolInput } from "./schema";

export type TaskToolDeps = {
  readonly scheduler: Scheduler;
  readonly handle: ThreadHandle;
};

export function buildTaskTool(deps: TaskToolDeps): ToolDefinition {
  return defineTool({
    name: "task",
    label: "task",
    description:
      "Manage scheduled/recurring tasks for this Telegram chat/thread.",
    parameters: taskToolSchema,
    async execute(_id, params) {
      const input = params as TaskToolInput;
      switch (input.action) {
        case "create":
          return await actionCreate(deps, input);
        case "list":
          return await actionList(deps);
        case "delete":
          return await actionDelete(deps, input);
        case "pause":
        case "resume":
          return await actionSetStatus(deps, input);
        case "update_prompt":
          return await actionUpdatePrompt(deps, input);
      }
    },
  });
}

async function actionCreate(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.prompt) {
    throw new Error("'prompt' is required for action=create");
  }
  if (!input.schedule) {
    throw new Error("'schedule' is required for action=create");
  }
  const task = await deps.scheduler.createTask(deps.handle, {
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

async function actionList(
  deps: TaskToolDeps
): Promise<AgentToolResult<unknown>> {
  const tasks = await deps.scheduler.listTasksFor(deps.handle);
  if (tasks.length === 0) {
    return {
      content: [
        { type: "text" as const, text: "No tasks scheduled for this thread." },
      ],
      details: { tasks: [] },
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
    details: { tasks },
  };
}

async function actionDelete(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.id) {
    throw new Error("'id' is required for action=delete");
  }
  const ok = await deps.scheduler.deleteTaskById(deps.handle, input.id);
  if (!ok) {
    throw new Error(`no task with id=${input.id} in this thread`);
  }
  return {
    content: [{ type: "text" as const, text: `Deleted task ${input.id}.` }],
    details: { id: input.id },
  };
}

async function actionSetStatus(
  deps: TaskToolDeps,
  input: TaskToolInput
): Promise<AgentToolResult<unknown>> {
  if (!input.id) {
    throw new Error(`'id' is required for action=${input.action}`);
  }
  const target = input.action === "pause" ? "paused" : "active";
  const task = await deps.scheduler.setStatus(deps.handle, input.id, target);
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

async function actionUpdatePrompt(
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
    deps.handle,
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
