import { expect, test } from "bun:test";
import { prefersApplyPatch } from "./model";

test.each([
  { provider: "openai", api: "openai-responses", id: "codex" },
  { provider: "codex", id: "gpt-5-codex" },
  { provider: "openai", id: "gpt-4o" },
  { provider: "copilot", id: "gpt-4.1" },
  { provider: "openai", id: "o3" },
  { provider: "openai", id: "o4-mini" },
  { provider: "custom", api: "codex" },
  { provider: "openrouter", id: "openai/gpt-4o" },
  { provider: "vercel-ai-gateway", id: "openai/o3" },
])("prefers apply_patch for %j", (model) => {
  expect(prefersApplyPatch(model)).toBe(true);
});

test.each([
  { provider: "openrouter", id: "eleutherai/gpt-neo" },
  { provider: "huggingface", id: "nomic-ai/gpt4all-j" },
  { provider: "openai", id: "text-embedding-3" },
  undefined,
])("prefers edit for %j", (model) => {
  expect(prefersApplyPatch(model)).toBe(false);
});
