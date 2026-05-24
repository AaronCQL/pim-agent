import { type Static, Type } from "typebox";

export const subagentSchema = Type.Object({
  prompt: Type.String({
    minLength: 1,
  }),
});

export type SubagentInput = Static<typeof subagentSchema>;
