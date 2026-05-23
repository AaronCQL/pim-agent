import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const todoItemSchema = Type.Object({
  content: Type.String(),
  status: StringEnum(STATUSES),
});

export const todoSchema = Type.Object({
  todos: Type.Array(todoItemSchema, {
    description: "The complete replacement task list, in priority order.",
  }),
});

export type TodoInput = Static<typeof todoSchema>;
export type TodoItem = Static<typeof todoItemSchema>;
export type TodoStatus = (typeof STATUSES)[number];
