import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, describeOs } from "./prompt";

describe("buildSystemPrompt", () => {
  test("emits a best-effort os field instead of process.platform", () => {
    const prompt = buildSystemPrompt({
      cwd: "/repo",
      contextFiles: [],
      skillsBlock: "",
      toolGuidelines: [],
      os: "Ubuntu 24.04.2 LTS",
    });

    expect(prompt).toContain("- os: Ubuntu 24.04.2 LTS");
    expect(prompt).not.toContain("- platform:");
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
