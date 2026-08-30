import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerSubagent from "./index";
import { subagentSchema } from "./schema";

function validate(args: unknown): void {
  validateToolArguments(
    { name: "subagent", parameters: subagentSchema } as never,
    {
      type: "toolCall",
      id: "1",
      name: "subagent",
      arguments: args as Record<string, unknown>,
    }
  );
}

describe("subagent extension registration", () => {
  test("schema rejects an empty prompt", () => {
    expect(() => validate({ prompt: "" })).toThrow();
  });

  test("registers one parallel tool without a prompt snippet", () => {
    let tool:
      | {
          readonly name: string;
          readonly executionMode?: string;
          readonly promptSnippet?: string;
          readonly parameters: unknown;
        }
      | undefined;
    registerSubagent({
      registerTool(def) {
        tool = def;
      },
    } as ExtensionAPI);

    expect(tool?.name).toBe("subagent");
    expect(tool?.executionMode).toBe("parallel");
    expect(tool?.promptSnippet).toBeUndefined();
    expect(tool?.parameters).toBe(subagentSchema);
  });
});
