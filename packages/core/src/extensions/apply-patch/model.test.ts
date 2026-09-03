import { describe, expect, test } from "bun:test";
import { prefersApplyPatch } from "./model";

describe("prefersApplyPatch", () => {
  test("positive: openai provider serving codex", () => {
    expect(
      prefersApplyPatch({
        provider: "openai",
        api: "openai-responses",
        id: "codex",
      })
    ).toBe(true);
  });

  test("positive: codex provider", () => {
    expect(prefersApplyPatch({ provider: "codex", id: "gpt-5-codex" })).toBe(
      true
    );
  });

  test("positive: openai + gpt", () => {
    expect(prefersApplyPatch({ provider: "openai", id: "gpt-4o" })).toBe(true);
  });

  test("positive: copilot serving gpt", () => {
    expect(prefersApplyPatch({ provider: "copilot", id: "gpt-4.1" })).toBe(
      true
    );
  });

  test("positive: o-series", () => {
    expect(prefersApplyPatch({ provider: "openai", id: "o3" })).toBe(true);
    expect(prefersApplyPatch({ provider: "openai", id: "o4-mini" })).toBe(true);
  });

  test("positive: codex substring in api", () => {
    expect(prefersApplyPatch({ provider: "custom", api: "codex" })).toBe(true);
  });

  test("positive: aggregator serving a vendor-namespaced openai id", () => {
    expect(
      prefersApplyPatch({ provider: "openrouter", id: "openai/gpt-4o" })
    ).toBe(true);
    expect(
      prefersApplyPatch({ provider: "vercel-ai-gateway", id: "openai/o3" })
    ).toBe(true);
  });

  test("positive: claude 5 generation", () => {
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-opus-5" })
    ).toBe(true);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-fable-5" })
    ).toBe(true);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-sonnet-5" })
    ).toBe(true);
  });

  test("positive: claude above 5, including minors and future majors", () => {
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-opus-5-1" })
    ).toBe(true);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-opus-6" })
    ).toBe(true);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-opus-10" })
    ).toBe(true);
  });

  test("positive: claude 5 via aggregator or bedrock id", () => {
    expect(
      prefersApplyPatch({
        provider: "openrouter",
        id: "anthropic/claude-opus-5",
      })
    ).toBe(true);
    expect(
      prefersApplyPatch({
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-5-v1:0",
      })
    ).toBe(true);
  });

  test("negative: claude below 5", () => {
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-sonnet-4" })
    ).toBe(false);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-opus-4-8" })
    ).toBe(false);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-haiku-4-5" })
    ).toBe(false);
    expect(
      prefersApplyPatch({
        provider: "anthropic",
        id: "claude-sonnet-4-5-20250929",
      })
    ).toBe(false);
  });

  test("negative: legacy claude id puts the version before the family", () => {
    expect(
      prefersApplyPatch({
        provider: "anthropic",
        id: "claude-3-5-sonnet-20241022",
      })
    ).toBe(false);
    expect(
      prefersApplyPatch({ provider: "anthropic", id: "claude-3-7-sonnet" })
    ).toBe(false);
  });

  test("negative: GPT-named non-OpenAI model via aggregator", () => {
    expect(
      prefersApplyPatch({ provider: "openrouter", id: "eleutherai/gpt-neo" })
    ).toBe(false);
    expect(
      prefersApplyPatch({ provider: "huggingface", id: "nomic-ai/gpt4all-j" })
    ).toBe(false);
  });

  test("negative: openai without gpt or o-series id", () => {
    expect(
      prefersApplyPatch({ provider: "openai", id: "text-embedding-3" })
    ).toBe(false);
  });

  test("negative: undefined model", () => {
    expect(prefersApplyPatch(undefined)).toBe(false);
  });
});
