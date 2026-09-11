import { describe, expect, test } from "bun:test";
import { OutputBudget } from "./OutputBudget";

describe("truncateLine", () => {
  test("returns lines under the cap untouched", () => {
    expect(OutputBudget.truncateLine("short")).toBe("short");
  });

  test("truncates with a signposted suffix once over the cap", () => {
    const line = "x".repeat(OutputBudget.maxLineLength + 50);
    expect(OutputBudget.truncateLine(line)).toBe(
      `${"x".repeat(OutputBudget.maxLineLength)}... (line truncated to ${OutputBudget.maxLineLength} chars)`
    );
  });
});

describe("truncateUtf8", () => {
  test("returns content unchanged when under cap", () => {
    const result = OutputBudget.truncateUtf8("hello", 1024);
    expect(result.body).toBe("hello");
    expect(result.truncated).toBe(false);
    expect(result.totalBytes).toBe(5);
    expect(result.returnedBytes).toBe(5);
  });

  test("truncates ASCII at exact byte boundary", () => {
    const result = OutputBudget.truncateUtf8("a".repeat(100), 10);
    expect(result.body).toBe("a".repeat(10));
    expect(result.truncated).toBe(true);
    expect(result.returnedBytes).toBe(10);
    expect(result.totalBytes).toBe(100);
  });

  test("backs off to a UTF-8 boundary mid-codepoint", () => {
    const result = OutputBudget.truncateUtf8("é", 1);
    expect(result.body).toBe("");
    expect(result.returnedBytes).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(2);
  });

  test("preserves complete multi-byte chars", () => {
    const result = OutputBudget.truncateUtf8("héllo", 3);
    expect(result.body).toBe("hé");
    expect(result.returnedBytes).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(6);
  });

  test("backs off across a 4-byte sequence", () => {
    const result = OutputBudget.truncateUtf8("🦀x", 2);
    expect(result.body).toBe("");
    expect(result.returnedBytes).toBe(0);
    expect(result.truncated).toBe(true);
  });

  test("defaults to OutputBudget.maxBytes when no cap supplied", () => {
    const content = "a".repeat(OutputBudget.maxBytes + 100);
    const result = OutputBudget.truncateUtf8(content);
    expect(result.body.length).toBe(OutputBudget.maxBytes);
    expect(result.truncated).toBe(true);
  });
});

describe("applyByteCap", () => {
  test("returns all items when their joined length fits", () => {
    const items = ["alpha", "beta", "gamma"];
    const result = OutputBudget.applyByteCap(items);
    expect(result.visible).toEqual(items);
    expect(result.droppedItems).toBe(0);
  });

  test("drops trailing items past the byte cap", () => {
    const item = "x".repeat(100);
    const items = Array.from({ length: 20 }, () => item);
    const result = OutputBudget.applyByteCap(items, { maxBytes: 250 });
    // 100 + 1 + 100 = 201 fits, adding another 1 + 100 = 302 does not.
    expect(result.visible).toHaveLength(2);
    expect(result.droppedItems).toBe(18);
  });

  test("always includes the first item even when it overflows alone", () => {
    const head = "x".repeat(500);
    const result = OutputBudget.applyByteCap([head, "tail"], {
      maxBytes: 100,
    });
    expect(result.visible).toEqual([head]);
    expect(result.droppedItems).toBe(1);
  });

  test("respects a custom separator", () => {
    // Two 5-byte items with a 10-byte separator: 5 + 10 + 5 = 20.
    const result = OutputBudget.applyByteCap(["alpha", "betas"], {
      maxBytes: 20,
      separator: "----------",
    });
    expect(result.visible).toEqual(["alpha", "betas"]);
  });
});
