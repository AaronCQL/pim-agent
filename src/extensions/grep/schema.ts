import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "typebox";

export const GREP_HEAD_LIMIT_MAX = 1000;

export const GREP_OUTPUT_MODES = [
  "files_with_matches",
  "content",
  "count",
] as const;

export const grepSchema = Type.Object({
  pattern: Type.String({
    description: "JavaScript regex source, without /.../ delimiters.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Absolute or relative path to file/directory (resolved against cwd). Defaults to cwd.",
    })
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Relative glob filter under path. Gitignored files and dotfiles are skipped.",
    })
  ),
  outputMode: Type.Optional(
    StringEnum(GREP_OUTPUT_MODES, {
      description:
        "`files_with_matches` (default): returns file paths. `content`: returns path:line:text. `count`: returns path:count.",
    })
  ),
  multiline: Type.Optional(
    Type.Boolean({
      description: "Use the regex `s` (dotall) flag. Defaults to false.",
    })
  ),
  caseInsensitive: Type.Optional(
    Type.Boolean({
      description: "Use the regex `i` flag. Defaults to false.",
    })
  ),
  headLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: GREP_HEAD_LIMIT_MAX,
      description: `Maximum returned items. Defaults to ${GREP_HEAD_LIMIT_MAX}.`,
    })
  ),
});

export type GrepInput = Static<typeof grepSchema>;

export type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];
