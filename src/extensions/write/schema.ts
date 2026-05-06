import { type Static, Type } from "typebox";

export const writeSchema = Type.Object({
  path: Type.String({
    description:
      "File path. Relative paths resolve against the working directory. Parent directories are created automatically.",
  }),
  content: Type.String({
    description:
      "Whole file content as UTF-8 text. Overwrites existing content.",
  }),
});

export type WriteInput = Static<typeof writeSchema>;
