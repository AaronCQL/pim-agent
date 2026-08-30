type ModelLike = {
  readonly provider?: string;
  readonly api?: string;
  readonly id?: string;
};

/**
 * Conservative GPT/Codex-family detection. False positives demote a model to a
 * tool it wasn't trained on, so misses beat false positives. Must NOT trigger
 * for anthropic, nor for GPT-*named* non-OpenAI models served by aggregators
 * (e.g. `eleutherai/gpt-neo`). It DOES trigger for a real OpenAI model routed
 * through a gateway, identified by a vendor-namespaced id (`openai/gpt-4o`).
 */
export function isGptModel(model: ModelLike | undefined): boolean {
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
