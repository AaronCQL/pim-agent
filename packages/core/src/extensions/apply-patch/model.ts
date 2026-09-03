type ModelLike = {
  readonly provider?: string;
  readonly api?: string;
  readonly id?: string;
};

const CLAUDE_APPLY_PATCH_MAJOR = 5;

/**
 * Conservative GPT/Codex-family detection. False positives demote a model to a
 * tool it wasn't trained on, so misses beat false positives. Must NOT trigger
 * for anthropic, nor for GPT-*named* non-OpenAI models served by aggregators
 * (e.g. `eleutherai/gpt-neo`). It DOES trigger for a real OpenAI model routed
 * through a gateway, identified by a vendor-namespaced id (`openai/gpt-4o`).
 */
function isGptModel(model: ModelLike | undefined): boolean {
  const provider = (model?.provider ?? "").toLowerCase();
  const api = (model?.api ?? "").toLowerCase();
  const id = (model?.id ?? "").toLowerCase();

  // OpenAI is identified by the provider, or by a vendor-namespaced id used by
  // aggregators (openrouter / vercel gateway serve "openai/gpt-4o"). Requiring
  // the explicit "openai/" prefix still excludes GPT-named non-OpenAI models
  // routed through the same aggregators.
  const isOpenAi = provider.includes("openai") || id.startsWith("openai/");

  return (
    provider.includes("codex") ||
    api.includes("codex") ||
    id.includes("codex") ||
    (isOpenAi && id.includes("gpt")) ||
    (isOpenAi && /(^|\/)o\d/.test(id)) ||
    ((provider.includes("copilot") || api.includes("copilot")) &&
      id.includes("gpt"))
  );
}

/**
 * Major version from a modern Claude id (`claude-<family>-<major>[-<minor>]`,
 * optionally namespaced by an aggregator or Bedrock). The family segment is
 * required, so the legacy `claude-3-5-sonnet` ordering yields nothing rather
 * than reading a version out of a differently shaped id. Unlike "gpt", "claude"
 * is not a widely reused name, so the id shape alone identifies the vendor and
 * one branch covers every gateway that reserves the id.
 */
function claudeMajorVersion(id: string): number | undefined {
  const match = /(?:^|[/.])claude-[a-z]+-(\d+)/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether the model is effective on V4A patches and should be handed
 * `apply_patch` in place of the string-replacement `edit` tool.
 */
export function prefersApplyPatch(model: ModelLike | undefined): boolean {
  if (isGptModel(model)) {
    return true;
  }
  const major = claudeMajorVersion((model?.id ?? "").toLowerCase());
  return major !== undefined && major >= CLAUDE_APPLY_PATCH_MAJOR;
}
