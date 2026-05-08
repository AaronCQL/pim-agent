import { type Static, Type } from "typebox";

export const MAX_READ_BYTES = 32 * 1024;
export const MAX_LINE_LENGTH = 2000;

export const readSchema = Type.Object({
  path: Type.String({
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
  start: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "First line to return, 1-indexed. Defaults to 1.",
    })
  ),
  end: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Last line to return, 1-indexed and inclusive. Defaults to EOF or the byte cap.",
    })
  ),
});

export type ReadInput = Static<typeof readSchema>;

export type ReadRange = {
  readonly start: number;
  readonly end?: number;
};
