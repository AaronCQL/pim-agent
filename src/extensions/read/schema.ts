import { type Static, Type } from "typebox";

export const MAX_READ_BYTES = 32 * 1024;

const readFormatSchema = Type.Union(
  [Type.Literal("hashline"), Type.Literal("plain")],
  {
    description:
      "Output format - `hashline` includes edit anchors, `plain` returns raw file. Defaults to `hashline`.",
  }
);

export const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read." }),
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
  format: Type.Optional(readFormatSchema),
});

export type ReadInput = Static<typeof readSchema>;

export type ReadFormat = Static<typeof readFormatSchema>;

export type ReadRange = {
  readonly start: number;
  readonly end?: number;
  readonly format: ReadFormat;
};
