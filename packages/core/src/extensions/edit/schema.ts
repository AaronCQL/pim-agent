import { type Static, Type } from "typebox";

export const editSchema = Type.Object({
  path: Type.String({
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
  edits: Type.Array(
    Type.Object(
      {
        oldString: Type.String({
          description:
            "Use the actual file content without the `LINE:` prefix from read output. Must be unique unless replaceAll=true. Include enough surrounding context for uniqueness.",
        }),
        newString: Type.String({
          description:
            "Replacement text. Empty string deletes the matched range.",
        }),
        replaceAll: Type.Optional(
          Type.Boolean({
            description:
              "If true, replaces every occurrence of oldString. Defaults to false.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    {
      minItems: 1,
      description:
        "Non-empty atomic batch of edits. Batched edits resolve against the initial file state and must not overlap. For sequential transformations where edit 2 depends on edit 1's result, use separate tool calls.",
    }
  ),
});

export type EditInput = Static<typeof editSchema>;

export type RawEdit = EditInput["edits"][number];
