type ModelLike = {
  readonly provider?: string;
  readonly api?: string;
  readonly id?: string;
};

// Must not match GPT-named non-OpenAI models such as `eleutherai/gpt-neo`.
export function prefersApplyPatch(model: ModelLike | undefined): boolean {
  const provider = (model?.provider ?? "").toLowerCase();
  const api = (model?.api ?? "").toLowerCase();
  const id = (model?.id ?? "").toLowerCase();

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
