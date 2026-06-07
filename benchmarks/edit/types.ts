// A benchmark "lane": the editing approach under test. This is distinct from
// the registered tool name pim sees at runtime. `edit` and `apply_patch` are
// pim's own tools (registered under those names); `hashline` is the third-party
// pi-hashline-edit extension, whose edit tool is itself registered as `edit`
// and is coupled to its own hash-anchored `read`. See harness.ts `resolveVariant`.
export type VariantId = "edit" | "apply_patch" | "hashline";

export type Task = {
  readonly id: string;
  readonly tag: string;
  readonly title: string;
  readonly files: readonly string[];
  readonly instruction: string;
  readonly dir: string;
};

export type ErrorKind =
  | "not_found"
  | "ambiguous"
  | "overlap"
  | "noop"
  | "identical"
  | "invalid_args"
  | "context_mismatch"
  | "malformed_patch"
  | "wrong_op"
  // hashline only: an edit referenced a stale LINE#HASH anchor (the file moved
  // under it). The signature hashline failure mode, kept distinct from
  // not_found because it is a freshness rejection, not a missing target.
  | "stale_anchor"
  | "other";

export type RunResult = {
  readonly taskId: string;
  readonly tag: string;
  // The benchmark lane (VariantId), not the registered tool name: a `hashline`
  // run reports `tool: "hashline"` even though pim sees the tool as `edit`.
  readonly tool: VariantId;
  readonly model: string;
  readonly rep: number;
  // Whether the on-disk file(s) exactly match the golden after the run.
  readonly finalCorrect: boolean;
  // Calls to the editing tool under test (excludes read and other tools).
  readonly editToolCalls: number;
  readonly editToolErrors: number;
  // First editing-tool call applied without error; null if the tool was never called.
  readonly firstCallValid: boolean | null;
  readonly errorKinds: readonly ErrorKind[];
  // edit only: the EditMatcher strategy that resolved each applied edit.
  // "simple" is an exact match; anything else is a fuzzy rescue. apply_patch and
  // hashline have no fuzzy matcher, so this is always empty for them.
  readonly strategies: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
};

export type RunOptions = {
  readonly workRoot: string;
  readonly timeoutMs: number;
  // Realistic mode (default): the model reads the file via the lane's read tool,
  // as in production. Inline mode: the file content is pasted into the prompt and
  // no read tool is offered, isolating raw format proficiency. Unsupported by the
  // hashline lane, whose edits need hash anchors that only its read emits.
  readonly inline: boolean;
  readonly allowRead: boolean;
  readonly keepWork: boolean;
};
