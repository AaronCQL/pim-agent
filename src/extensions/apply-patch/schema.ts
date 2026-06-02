import { type Static, Type } from "typebox";

export const applyPatchSchema = Type.Object({
  input: Type.String({
    description: "Patch text wrapped in *** Begin Patch / *** End Patch.",
  }),
});

export type ApplyPatchInput = Static<typeof applyPatchSchema>;

const ALIAS_KEYS = ["patch", "patchText", "patch_text"] as const;

/**
 * Forgive the JSON-key choice, trust the grammar. Accepts `{input}` (canonical,
 * handled above), `{patch}`, `{patchText}`/`{patch_text}`, or a bare string,
 * normalizing to `{input}` and stripping the alias key so the unknown-key
 * rejection in `Tools.wrap` passes. Validation of the actual envelope happens
 * in the parser.
 */
export function prepareApplyPatchArguments(rawArgs: unknown): ApplyPatchInput {
  if (typeof rawArgs === "string") {
    return { input: rawArgs };
  }

  if (rawArgs === null || typeof rawArgs !== "object") {
    return rawArgs as ApplyPatchInput;
  }

  const record = rawArgs as Record<string, unknown>;
  if (typeof record.input === "string") {
    return rawArgs as ApplyPatchInput;
  }

  for (const key of ALIAS_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      const { [key]: _dropped, ...rest } = record;
      return { ...rest, input: value } as ApplyPatchInput;
    }
  }

  return rawArgs as ApplyPatchInput;
}
