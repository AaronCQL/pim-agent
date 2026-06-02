import { describe, expect, test } from "bun:test";
import { isGptModel } from "./model";

describe("isGptModel", () => {
  test("positive: openai provider serving codex", () => {
    expect(
      isGptModel({ provider: "openai", api: "openai-responses", id: "codex" })
    ).toBe(true);
  });

  test("positive: codex provider", () => {
    expect(isGptModel({ provider: "codex", id: "gpt-5-codex" })).toBe(true);
  });

  test("positive: openai + gpt", () => {
    expect(isGptModel({ provider: "openai", id: "gpt-4o" })).toBe(true);
  });

  test("positive: copilot serving gpt", () => {
    expect(isGptModel({ provider: "copilot", id: "gpt-4.1" })).toBe(true);
  });

  test("positive: o-series", () => {
    expect(isGptModel({ provider: "openai", id: "o3" })).toBe(true);
    expect(isGptModel({ provider: "openai", id: "o4-mini" })).toBe(true);
  });

  test("positive: codex substring in api", () => {
    expect(isGptModel({ provider: "custom", api: "codex" })).toBe(true);
  });

  test("positive: aggregator serving a vendor-namespaced openai id", () => {
    expect(isGptModel({ provider: "openrouter", id: "openai/gpt-4o" })).toBe(
      true
    );
    expect(isGptModel({ provider: "vercel-ai-gateway", id: "openai/o3" })).toBe(
      true
    );
  });

  test("negative: anthropic", () => {
    expect(isGptModel({ provider: "anthropic", id: "claude-sonnet-4" })).toBe(
      false
    );
  });

  test("negative: GPT-named non-OpenAI model via aggregator", () => {
    expect(
      isGptModel({ provider: "openrouter", id: "eleutherai/gpt-neo" })
    ).toBe(false);
    expect(
      isGptModel({ provider: "huggingface", id: "nomic-ai/gpt4all-j" })
    ).toBe(false);
  });

  test("negative: openai without gpt or o-series id", () => {
    expect(isGptModel({ provider: "openai", id: "text-embedding-3" })).toBe(
      false
    );
  });

  test("negative: undefined model", () => {
    expect(isGptModel(undefined)).toBe(false);
  });
});
