import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Levenshtein } from "./Levenshtein";

type Issue = { readonly path: string; readonly message: string };

type JsonSchema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema | readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly enum?: readonly unknown[];
};

export class Tools {
  /**
   * Wrap a tool definition so pi's validator errors get rewritten before they
   * reach the model. Pi runs `prepareArguments` before validation, so we call
   * pi's validator ourselves inside it, rewrite any throw, and return the
   * (coerced) args; pi's own second validation pass then sees clean input.
   * After successful validation we also reject unknown top-level keys, since
   * TypeBox object schemas accept them by default and typos like
   * `headlimit` vs `head_limit` would silently no-op.
   *
   * Use `Tools.register` for `pi.registerTool` callers; use `Tools.wrap` to
   * pass into `customTools`.
   */
  static wrap<TParams extends TSchema, TDetails = unknown, TState = unknown>(
    def: ToolDefinition<TParams, TDetails, TState>
  ): ToolDefinition<TParams, TDetails, TState> {
    const schema = def.parameters as unknown as JsonSchema;
    return {
      ...def,
      prepareArguments: (rawArgs: unknown): Static<TParams> => {
        const prepared = def.prepareArguments
          ? def.prepareArguments(rawArgs)
          : (rawArgs as Static<TParams>);
        const cleaned = coerceQuotedEnums(prepared, schema) as Static<TParams>;
        const strictIssues = checkStrictTypes(cleaned, schema, "");
        if (strictIssues.length > 0) {
          const lines = strictIssues.map((s) => `  - ${s}`).join("\n");
          throw new Error(
            `Validation failed for tool "${def.name}":\n${lines}`
          );
        }
        let validated: Static<TParams>;
        try {
          validated = validateToolArguments(
            { name: def.name, parameters: def.parameters } as never,
            {
              type: "toolCall",
              id: "",
              name: def.name,
              arguments: cleaned as Record<string, unknown>,
            }
          ) as Static<TParams>;
        } catch (err) {
          throw new Error(
            Tools.rewriteValidationError(def.name, schema, err, cleaned)
          );
        }
        const unknownKeys = findUnknownTopLevelKeys(schema, validated);
        if (unknownKeys.length > 0) {
          throw new Error(
            formatUnknownKeysError(def.name, schema, unknownKeys)
          );
        }
        return validated;
      },
    };
  }

  static register<
    TParams extends TSchema,
    TDetails = unknown,
    TState = unknown,
  >(pi: ExtensionAPI, def: ToolDefinition<TParams, TDetails, TState>): void {
    pi.registerTool(Tools.wrap(def));
  }

  /**
   * Rewrite a `validateToolArguments` error string into a clearer form.
   * `schema` is the tool's parameters schema, used to enumerate allowed values
   * for `anyOf`/`enum` failures. `args` is the validated input, used to pick
   * the matching branch of a discriminated union. Public for testing.
   */
  static rewriteValidationError(
    toolName: string,
    schema: JsonSchema,
    err: unknown,
    args?: unknown
  ): string {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Validation failed for tool")) {
      return message;
    }

    const raw = parseIssues(message);
    const collapsed = collapseAnyOf(raw, schema, args);
    const issues = collapsed.map((issue) => formatIssue(issue, schema));

    const header = `Validation failed for tool "${toolName}":`;
    if (issues.length === 0) {
      return header;
    }
    return `${header}\n${issues.map((s) => `  - ${s}`).join("\n")}`;
  }
}

function parseIssues(message: string): Issue[] {
  const issues: Issue[] = [];
  for (const line of message.split("\n")) {
    if (line.startsWith("Received arguments:")) {
      break;
    }
    if (!line.startsWith("  - ")) {
      continue;
    }
    const body = line.slice(4);
    const colonIdx = body.indexOf(": ");
    if (colonIdx === -1) {
      issues.push({ path: "", message: body });
    } else {
      issues.push({
        path: body.slice(0, colonIdx),
        message: body.slice(colonIdx + 2),
      });
    }
  }
  return issues;
}

/**
 * Pi emits one error per anyOf branch plus a `must match a schema in anyOf`
 * parent error, producing 6+ noisy lines for a 6-variant union. Replace the
 * whole cluster with a single synthesised line. If the actual value has a
 * discriminator that matches one branch, surface only that branch's real
 * errors instead.
 */
function collapseAnyOf(
  issues: readonly Issue[],
  schema: JsonSchema,
  args: unknown
): Issue[] {
  const handled = new Set<number>();
  const inserts = new Map<number, Issue[]>();

  issues.forEach((issue, idx) => {
    if (handled.has(idx) || issue.message !== "must match a schema in anyOf") {
      return;
    }
    const node = walkSchema(schema, issue.path);
    const branches = node?.anyOf ?? node?.oneOf;
    if (!node || !branches) {
      return;
    }
    handled.add(idx);
    issues.forEach((other, otherIdx) => {
      if (handled.has(otherIdx)) {
        return;
      }
      if (other.path === issue.path || isUnderPath(other.path, issue.path)) {
        handled.add(otherIdx);
      }
    });

    const value = walkValue(args, issue.path);
    const matched = matchDiscriminatedBranch(branches, value);
    if (matched) {
      const branchIssues = revalidateBranch(matched, value).map((sub) => ({
        path: joinPath(issue.path, sub.path),
        message: sub.message,
      }));
      inserts.set(idx, branchIssues);
    } else {
      inserts.set(idx, [
        { path: issue.path, message: describeAnyOf(branches) },
      ]);
    }
  });

  const result: Issue[] = [];
  issues.forEach((issue, idx) => {
    if (inserts.has(idx)) {
      result.push(...inserts.get(idx)!);
      return;
    }
    if (!handled.has(idx)) {
      result.push(issue);
    }
  });
  return result;
}

function describeAnyOf(branches: readonly JsonSchema[]): string {
  const constValues = branches
    .map((b) => (b && "const" in b ? b.const : undefined))
    .filter((v) => v !== undefined);
  if (constValues.length === branches.length) {
    return `must be one of: ${constValues.map(displayValue).join(", ")}`;
  }

  const discriminator = findDiscriminator(branches);
  if (discriminator) {
    const values = discriminator.values.map(displayValue).join(", ");
    return `must match one of the allowed variants (${discriminator.field}: ${values})`;
  }

  return `must match one of ${branches.length} allowed variants`;
}

/**
 * Format an enum value for an error message. Strings render bare so a weaker
 * model that retries off the message doesn't include the quotes in its next
 * attempt (e.g. `action: "\"create\""`). Non-strings keep JSON form for
 * disambiguation.
 */
function displayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function matchDiscriminatedBranch(
  branches: readonly JsonSchema[],
  value: unknown
): JsonSchema | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const discriminator = findDiscriminator(branches);
  if (!discriminator) {
    return undefined;
  }
  const actual = value[discriminator.field];
  const branchIndex = discriminator.values.findIndex(
    (v) => JSON.stringify(v) === JSON.stringify(actual)
  );
  return branchIndex >= 0 ? branches[branchIndex] : undefined;
}

function findDiscriminator(
  branches: readonly JsonSchema[]
): { readonly field: string; readonly values: readonly unknown[] } | undefined {
  const objectBranches = branches.filter(
    (b) => b.type === "object" && b.properties
  );
  if (
    objectBranches.length !== branches.length ||
    objectBranches.length === 0
  ) {
    return undefined;
  }
  for (const propName of Object.keys(objectBranches[0]!.properties!)) {
    const values: unknown[] = [];
    for (const branch of objectBranches) {
      const prop = branch.properties![propName];
      if (prop && "const" in prop) {
        values.push(prop.const);
      } else {
        break;
      }
    }
    if (
      values.length === objectBranches.length &&
      new Set(values.map((v) => JSON.stringify(v))).size === values.length
    ) {
      return { field: propName, values };
    }
  }
  return undefined;
}

function revalidateBranch(branch: JsonSchema, value: unknown): Issue[] {
  try {
    validateToolArguments(
      { name: "_branch", parameters: branch as TSchema } as never,
      {
        type: "toolCall",
        id: "",
        name: "_branch",
        arguments: (value ?? {}) as Record<string, unknown>,
      }
    );
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return parseIssues(message);
  }
}

function walkSchema(
  schema: JsonSchema | undefined,
  path: string
): JsonSchema | undefined {
  if (!schema) {
    return undefined;
  }
  if (!path) {
    return schema;
  }
  let current: JsonSchema | undefined = schema;
  for (const part of path.split(".")) {
    if (!current) {
      return undefined;
    }
    if (current.properties && part in current.properties) {
      current = current.properties[part];
      continue;
    }
    if (current.items) {
      current = Array.isArray(current.items)
        ? current.items[Number(part)]
        : current.items;
      continue;
    }
    return undefined;
  }
  return current;
}

function walkValue(value: unknown, path: string): unknown {
  if (!path) {
    return value;
  }
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function isUnderPath(candidate: string, parent: string): boolean {
  if (!parent) {
    return candidate.length > 0;
  }
  return candidate.startsWith(`${parent}.`);
}

function joinPath(parent: string, child: string): string {
  if (!parent) {
    return child;
  }
  if (!child) {
    return parent;
  }
  return `${parent}.${child}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssue(issue: Issue, schema: JsonSchema): string {
  const requiredMatch = issue.message.match(
    /^must have required propert(?:y|ies) (.+)$/
  );
  if (requiredMatch) {
    const props = requiredMatch[1]!;
    const parent = issue.path.includes(".")
      ? issue.path.slice(0, issue.path.lastIndexOf("."))
      : "";
    const where = parent ? ` at ${parent}` : "";
    const noun = props.includes(",") ? "properties" : "property";
    return `missing required ${noun}${where}: ${props}`;
  }

  if (issue.message === "must be equal to one of the allowed values") {
    const node = walkSchema(schema, issue.path);
    if (node?.enum && node.enum.length > 0) {
      const values = node.enum.map(displayValue).join(", ");
      return `${issue.path}: must be one of: ${values}`;
    }
  }

  if (!issue.path) {
    return issue.message;
  }
  return `${issue.path}: ${issue.message}`;
}

/**
 * Recursively unwrap quoted enum values. Weaker models sometimes send
 * `"\"create\""` instead of `"create"` because the JSON Schema and earlier
 * error messages show enum values quoted. Only unwraps when the inner value is
 * a valid enum/const match, so real typos still surface as errors.
 */
function coerceQuotedEnums(
  value: unknown,
  schema: JsonSchema | undefined
): unknown {
  if (!schema) {
    return value;
  }

  if (typeof value === "string") {
    const allowed = collectAllowedStrings(schema);
    if (allowed && allowed.length > 0 && !allowed.includes(value)) {
      const unwrapped = stripWrappingQuotes(value);
      if (unwrapped !== value && allowed.includes(unwrapped)) {
        return unwrapped;
      }
    }
    return value;
  }

  if (isRecord(value)) {
    let mutated: Record<string, unknown> | undefined;
    const propSchemas = schema.properties;
    for (const key of Object.keys(value)) {
      const subSchema = propSchemas?.[key];
      const next = coerceQuotedEnums(value[key], subSchema);
      if (next !== value[key]) {
        mutated ??= { ...value };
        mutated[key] = next;
      }
    }
    if (schema.anyOf || schema.oneOf) {
      const branches = (schema.anyOf ?? schema.oneOf) as readonly JsonSchema[];
      const branch =
        matchDiscriminatedBranch(branches, mutated ?? value) ??
        branches.find((b) => b.type === "object" && b.properties);
      if (branch) {
        const recursed = coerceQuotedEnums(mutated ?? value, branch);
        if (recursed !== (mutated ?? value)) {
          return recursed;
        }
      }
    }
    return mutated ?? value;
  }

  if (Array.isArray(value)) {
    const itemsField = schema.items;
    if (!itemsField || Array.isArray(itemsField)) {
      return value;
    }
    const itemSchema = itemsField as JsonSchema;
    let mutated: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = coerceQuotedEnums(value[i], itemSchema);
      if (next !== value[i]) {
        mutated ??= [...value];
        mutated[i] = next;
      }
    }
    return mutated ?? value;
  }

  return value;
}

function collectAllowedStrings(schema: JsonSchema): string[] | undefined {
  if (schema.enum) {
    const strings = schema.enum.filter(
      (v): v is string => typeof v === "string"
    );
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof schema.const === "string") {
    return [schema.const];
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const collected: string[] = [];
    for (const branch of branches) {
      const inner = collectAllowedStrings(branch);
      if (inner) {
        collected.push(...inner);
      }
    }
    return collected.length > 0 ? collected : undefined;
  }
  return undefined;
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0]!;
  const last = value[value.length - 1]!;
  const quoteChars = ['"', "'", "`"];
  if (quoteChars.includes(first) && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Pi-ai intentionally coerces a lot of LLM-quirk inputs (`"42"` → 42,
 * `"true"` → true, single value → array, etc.) so weak/cheap models don't
 * fail on JSON shakiness. This is good. But two of those coercions are
 * almost certainly silent bugs:
 *
 * - `null` → `0` / `""` / `false` / `"null"` for primitive fields. `null`
 *   is never a sensible value for a non-nullable primitive; treating it as
 *   the type's zero value hides the model's confusion.
 * - `"42.5"` → `42` for an integer field. The float-shaped string means the
 *   model misunderstood the type; truncating loses information without
 *   recovering the intent.
 *
 * Reject both before pi's `Value.Convert` runs.
 */
function checkStrictTypes(
  value: unknown,
  schema: JsonSchema | undefined,
  path: string
): string[] {
  if (!schema) {
    return [];
  }

  const types = collectSchemaTypes(schema);
  if (types.length > 0 && !types.includes("null") && value === null) {
    return [
      `${path || "root"}: must not be null (expected ${types.join(" | ")})`,
    ];
  }

  if (
    types.includes("integer") &&
    typeof value === "string" &&
    /^-?\d+\.\d*[1-9]/.test(value)
  ) {
    return [
      `${path || "root"}: must be an integer (received "${value}" — fractional part would be truncated)`,
    ];
  }

  if (isRecord(value) && schema.properties) {
    const issues: string[] = [];
    for (const [key, sub] of Object.entries(value)) {
      const subSchema = schema.properties[key];
      if (subSchema) {
        issues.push(...checkStrictTypes(sub, subSchema, joinPath(path, key)));
      }
    }
    return issues;
  }

  if (Array.isArray(value)) {
    const itemsField = schema.items;
    if (!itemsField || Array.isArray(itemsField)) {
      return [];
    }
    const itemSchema = itemsField as JsonSchema;
    const issues: string[] = [];
    for (let i = 0; i < value.length; i++) {
      issues.push(
        ...checkStrictTypes(value[i], itemSchema, joinPath(path, String(i)))
      );
    }
    return issues;
  }

  return [];
}

function collectSchemaTypes(schema: JsonSchema): string[] {
  const types = new Set<string>();
  if (typeof schema.type === "string") {
    types.add(schema.type);
  }
  if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      if (typeof t === "string") {
        types.add(t);
      }
    }
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    for (const b of branches) {
      for (const t of collectSchemaTypes(b)) {
        types.add(t);
      }
    }
  }
  return Array.from(types);
}

function findUnknownTopLevelKeys(schema: JsonSchema, args: unknown): string[] {
  if (schema.type !== "object" || !schema.properties || !isRecord(args)) {
    return [];
  }
  const known = new Set(Object.keys(schema.properties));
  return Object.keys(args).filter((key) => !known.has(key));
}

function formatUnknownKeysError(
  toolName: string,
  schema: JsonSchema,
  unknownKeys: readonly string[]
): string {
  const known = schema.properties ? Object.keys(schema.properties) : [];
  const lines = unknownKeys.map((key) => {
    const suggestion = closestKey(key, known);
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
    return `  - unknown property: ${key}${hint}`;
  });
  return `Validation failed for tool "${toolName}":\n${lines.join("\n")}`;
}

function closestKey(
  key: string,
  candidates: readonly string[]
): string | undefined {
  const lowered = key.toLowerCase();
  let best: { key: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === lowered) {
      return candidate;
    }
    const d = Levenshtein.distance(lowered, candidate.toLowerCase());
    if (d <= Math.max(2, Math.floor(candidate.length / 3))) {
      if (!best || d < best.distance) {
        best = { key: candidate, distance: d };
      }
    }
  }
  return best?.key;
}
