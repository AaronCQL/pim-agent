import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { SessionId } from "./Session";
import type { TaskScheduler } from "./TaskScheduler";
import { taskToolSchema, type TaskToolInput } from "./TaskSchema";

export type TaskToolDeps = {
  readonly scheduler: TaskScheduler;
  readonly sessionId: SessionId;
};

export class TaskTool {
  public static build(deps: TaskToolDeps): ToolDefinition {
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
            return await TaskTool.create(deps, input);
          case "list":
            return await TaskTool.list(deps);
          case "delete":
            return await TaskTool.delete(deps, input);
          case "pause":
          case "resume":
            return await TaskTool.setStatus(deps, input);
          case "update_prompt":
            return await TaskTool.updatePrompt(deps, input);
        }
      },
    });
  }

  private static async create(
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

  private static async list(
    deps: TaskToolDeps
  ): Promise<AgentToolResult<unknown>> {
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

  private static async delete(
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

  private static async setStatus(
    deps: TaskToolDeps,
    input: TaskToolInput
  ): Promise<AgentToolResult<unknown>> {
    if (!input.id) {
      throw new Error(`'id' is required for action=${input.action}`);
    }
    const target = input.action === "pause" ? "paused" : "active";
    const task = await deps.scheduler.setStatus(
      deps.sessionId,
      input.id,
      target
    );
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

  private static async updatePrompt(
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
}
