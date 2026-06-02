import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const GLOB_HEAD_LIMIT_MAX = 1000;

export const GLOB_PATH_FORMATS = ["relative", "absolute"] as const;

export const globSchema = Type.Object({
  pattern: Type.String({
    description:
      "Glob pattern relative to path (eg. **/*.ts). Brace expansion spans sibling dirs (eg. {src,docs}/**/*.ts).",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Absolute or relative path to directory (resolved against cwd). Defaults to cwd.",
    })
  ),
  exclude: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Glob patterns to exclude, relative to path (eg. **/*.test.ts or dist/**).",
    })
  ),
  includeDotfiles: Type.Optional(
    Type.Boolean({
      description:
        "Include dot-prefixed files and directories such as .env or .github. Defaults to false.",
    })
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({
      description:
        "Include gitignored and normally ignored paths such as node_modules. Defaults to false.",
    })
  ),
  pathFormat: Type.Optional(
    StringEnum(GLOB_PATH_FORMATS, {
      description:
        "`relative` (default): output paths relative to cwd when possible. `absolute`: output absolute paths.",
    })
  ),
  headLimit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: GLOB_HEAD_LIMIT_MAX,
      description: `Maximum returned entries. Defaults to ${GLOB_HEAD_LIMIT_MAX}.`,
    })
  ),
});

export type GlobInput = Static<typeof globSchema>;
export type GlobPathFormat = (typeof GLOB_PATH_FORMATS)[number];
