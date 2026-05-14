import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import { FuzzyMatcher, type FuzzyCandidate } from "../shared/FuzzyMatcher.ts";

export type ModelResolveResult =
  | { readonly kind: "ok"; readonly model: Model<Api> }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly candidates: readonly string[] };

export function resolveModel(
  registry: ModelRegistry,
  pattern: string
): ModelResolveResult {
  const available = registry.getAvailable();
  const candidates: FuzzyCandidate<Model<Api>>[] = available.map((m) => ({
    item: m,
    haystacks: [modelId(m), m.id, m.name],
  }));

  const exact = available.find(
    (m) =>
      modelId(m) === pattern.trim() ||
      m.id === pattern.trim() ||
      m.name === pattern.trim()
  );
  if (exact) {
    return { kind: "ok", model: exact };
  }

  const hits = FuzzyMatcher.rank(pattern, candidates, { limit: 5 });
  if (hits.length === 0) {
    return {
      kind: "none",
      candidates: available.slice(0, 8).map(modelId),
    };
  }
  if (hits.length === 1) {
    return { kind: "ok", model: hits[0]!.item };
  }
  const top = hits[0]!;
  const second = hits[1]!;
  if (top.score > second.score * 1.5) {
    return { kind: "ok", model: top.item };
  }
  return {
    kind: "ambiguous",
    candidates: hits.map((h) => modelId(h.item)),
  };
}

export function modelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}
