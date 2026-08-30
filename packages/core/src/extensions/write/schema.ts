import { type Static, Type } from "typebox";

export const writeSchema = Type.Object({
  path: Type.String({
    description:
      "Absolute or relative path to file (resolved against cwd). Parent directories are created if missing.",
  }),
  content: Type.String({
    description:
      "UTF-8 text written verbatim. Include a trailing newline if needed.",
  }),
});

export type WriteInput = Static<typeof writeSchema>;
