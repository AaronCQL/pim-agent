import { describe, expect, test } from "bun:test";
import {
  buildEnvironment,
  buildInstructions,
  describeOs,
  formatDatetime,
  leadWithSystemPrompt,
} from "./prompt";

describe("buildInstructions", () => {
  test("wraps pim's identity and the guideline bullets in one tagged block", () => {
    const instructions = buildInstructions({
      selectedTools: [],
      toolGuidelines: {},
      promptGuidelines: ["Be terse", "Cite paths"],
    });

    expect(instructions.startsWith("<system_instructions>\n")).toBe(true);
    expect(instructions.endsWith("\n</system_instructions>")).toBe(true);
    expect(instructions).toContain(
      "You are Pim (Pi IMproved), a batteries-included agent built on the Pi harness."
    );
    expect(instructions).toContain("- Be terse\n- Cite paths");
  });

  test("carries the active tools' guidelines once, and drops inactive ones", () => {
    const instructions = buildInstructions({
      selectedTools: ["lint", "read"],
      toolGuidelines: {
        lint: ["Lint before committing", "Be terse"],
        deploy: ["Never deploy on Fridays"],
      },
      promptGuidelines: ["Be terse"],
    });

    expect(instructions).toContain("- Lint before committing\n- Be terse\n");
    expect(instructions.match(/- Be terse/g)).toHaveLength(1);
    expect(instructions).not.toContain("Fridays");
  });
});

describe("leadWithSystemPrompt", () => {
  test("moves the first system message to the front and keeps the rest in order", () => {
    const messages = [
      { role: "custom", id: "stamp" },
      { role: "system", id: "prompt" },
      { role: "user", id: "ask" },
      { role: "system", id: "delta" },
    ];

    expect(leadWithSystemPrompt(messages)?.map((m) => m.id)).toEqual([
      "prompt",
      "stamp",
      "ask",
      "delta",
    ]);
  });

  test("leaves a transcript that already leads with, or lacks, a prompt", () => {
    expect(
      leadWithSystemPrompt([{ role: "system" }, { role: "user" }])
    ).toBeUndefined();
    expect(leadWithSystemPrompt([{ role: "user" }])).toBeUndefined();
  });
});

describe("buildEnvironment", () => {
  test("emits a best-effort os field instead of process.platform", () => {
    const environment = buildEnvironment({ os: "Ubuntu 24.04.2 LTS" });

    expect(environment).toContain("- os: Ubuntu 24.04.2 LTS");
    expect(environment).not.toContain("- platform:");
  });

  test("names the surface the user is on, and omits it for a subagent", () => {
    const os = "Ubuntu 24.04.2 LTS";

    expect(buildEnvironment({ os, surface: "web browser" })).toContain(
      "- surface: web browser"
    );
    expect(buildEnvironment({ os })).not.toContain("- surface:");
  });

  test("leaves tagging, cwd and datetime to pi", () => {
    expect(
      buildEnvironment({
        os: "Ubuntu 24.04.2 LTS",
        model: { id: "opus", provider: "anthropic" },
      })
    ).toBe("- os: Ubuntu 24.04.2 LTS\n- model: opus via anthropic");
  });
});

describe("formatDatetime", () => {
  test("keeps second precision and names the weekday", () => {
    expect(formatDatetime(new Date(2026, 8, 20, 9, 54, 14))).toMatch(
      /^2026-09-20T09:54:14[+-]\d{2}:\d{2} \(Sunday\)$/
    );
  });
});

describe("describeOs", () => {
  test("uses PRETTY_NAME from /etc/os-release on Linux", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: (cmd) =>
        cmd.join(" ") === "cat /etc/os-release"
          ? 'NAME="Ubuntu"\nVERSION="24.04.2 LTS"\nPRETTY_NAME="Ubuntu 24.04.2 LTS"\n'
          : undefined,
    });

    expect(os).toBe("Ubuntu 24.04.2 LTS");
  });

  test("formats macOS from sw_vers", () => {
    const os = describeOs({
      platform: "darwin",
      runCommand: (cmd) =>
        cmd.join(" ") === "sw_vers"
          ? "ProductName:\t\tmacOS\nProductVersion:\t15.5\nBuildVersion:\t\t24F74\n"
          : undefined,
    });

    expect(os).toBe("macOS 15.5");
  });

  test("falls back to process platform when no probe succeeds", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: () => undefined,
    });

    expect(os).toBe("linux");
  });

  test("falls back to NAME and VERSION when PRETTY_NAME is absent", () => {
    const os = describeOs({
      platform: "linux",
      runCommand: (cmd) =>
        cmd.join(" ") === "cat /etc/os-release"
          ? 'NAME=Fedora\nVERSION="40 (Workstation Edition)"'
          : undefined,
    });

    expect(os).toBe("Fedora 40 (Workstation Edition)");
  });
});
