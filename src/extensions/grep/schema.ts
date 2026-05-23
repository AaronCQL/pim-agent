import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const GREP_HEAD_LIMIT_MAX = 1000;
export const GREP_CONTEXT_MAX = 20;

export const GREP_OUTPUT_MODES = [
  "files_with_matches",
  "content",
  "count",
] as const;

export const GREP_PATH_FORMATS = ["relative", "absolute"] as const;

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
        "Relative glob filter under path when path is a directory. Gitignored files and dotfiles are skipped during directory scans unless includeIgnored/includeDotfiles is true.",
    })
  ),
  exclude: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Glob patterns to exclude from directory searches, relative to path (eg. **/*.test.ts or dist/**).",
    })
  ),
  outputMode: Type.Optional(
    StringEnum(GREP_OUTPUT_MODES, {
      description:
        "`files_with_matches` (default): returns file paths. `content`: returns path:line:text. `count`: returns path:count.",
    })
  ),
  matchAcrossLines: Type.Optional(
    Type.Boolean({
      description:
        "Search whole files so one match can span line breaks. Defaults to false.",
    })
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: GREP_CONTEXT_MAX,
      description:
        "For outputMode='content', include this many lines before and after each match. Defaults to 0.",
    })
  ),
  includeDotfiles: Type.Optional(
    Type.Boolean({
      description:
        "Include dot-prefixed files and directories such as .env or .github during directory scans. Defaults to false.",
    })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({
      description:
        "Include gitignored and normally ignored paths such as node_modules during directory scans. Defaults to false.",
    })
  ),
  pathFormat: Type.Optional(
    StringEnum(GREP_PATH_FORMATS, {
      description:
        "`relative` (default): output paths relative to cwd when possible. `absolute`: output absolute paths.",
    })
  ),
  caseInsensitive: Type.Optional(
    Type.Boolean({
      description: "Search case-insensitively. Defaults to false.",
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
export type GrepPathFormat = (typeof GREP_PATH_FORMATS)[number];
