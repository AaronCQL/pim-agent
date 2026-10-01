import { describe, expect, test } from "bun:test";

import { type Install } from "./Supervisor";
import { Updater, type UpdateFacts, type UpdateStep } from "./Updater";

const dev: Install = {
  kind: "dev",
  packageRoot: "/home/dev/pim",
  pimEntry: "/home/dev/pim/bin/pim.ts",
  bunPath: "/home/dev/.bun/bin/bun",
};

const prod: Install = {
  kind: "prod",
  packageRoot: "/opt/pim",
  pimEntry: "/opt/pim/bin/pim.ts",
  bunPath: "/opt/bun/bin/bun",
};

function facts(over: Partial<UpdateFacts> = {}): UpdateFacts {
  return {
    at: dev,
    packageName: "pim-agent",
    cleanTree: true,
    tracked: true,
    latest: undefined,
    ...over,
  };
}

function argv(steps: ReadonlyArray<UpdateStep>): ReadonlyArray<string[]> {
  return steps.flatMap((step) =>
    "command" in step ? [[...step.command]] : []
  );
}

describe("plan for a dev checkout", () => {
  test("pulls, installs, then builds the client into staging and swaps it in", () => {
    const { steps, skipped } = Updater.plan(facts());

    expect(argv(steps)).toEqual([
      ["git", "pull", "--ff-only"],
      ["bun", "install"],
      ["bun", "run", "web:build", "--", "--outDir", "dist/staging"],
    ]);
    expect(steps.map((step) => "command" in step)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(
      steps.map((step) => ("command" in step ? step.cwd : undefined))
    ).toEqual([dev.packageRoot, dev.packageRoot, dev.packageRoot, undefined]);
    expect(skipped).toEqual([]);
  });

  test("skips the pull on a dirty tree as non-blocking", () => {
    const { steps, skipped } = Updater.plan(facts({ cleanTree: false }));

    expect(argv(steps)).toEqual([
      ["bun", "install"],
      ["bun", "run", "web:build", "--", "--outDir", "dist/staging"],
    ]);
    expect(skipped).toEqual([
      {
        label: "git pull",
        reason: "the working tree has uncommitted changes",
        blocking: false,
      },
    ]);
  });

  test("skips the pull on a branch with no upstream", () => {
    const { steps, skipped } = Updater.plan(facts({ tracked: false }));

    expect(argv(steps)).toEqual([
      ["bun", "install"],
      ["bun", "run", "web:build", "--", "--outDir", "dist/staging"],
    ]);
    expect(skipped).toEqual([
      {
        label: "git pull",
        reason: "this branch has no upstream to pull from",
        blocking: false,
      },
    ]);
  });

  test("names the missing upstream once, not the dirty tree too", () => {
    const { skipped } = Updater.plan(
      facts({ tracked: false, cleanTree: false })
    );

    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain("no upstream");
  });
});

describe("plan for a prod install", () => {
  test("installs the exact published version globally, and builds nothing", () => {
    const { steps, skipped } = Updater.plan(
      facts({ at: prod, latest: "1.4.2" })
    );

    expect(argv(steps)).toEqual([["bun", "install", "-g", "pim-agent@1.4.2"]]);
    expect(steps.map((step) => step.label)).toEqual([
      "install pim-agent@1.4.2",
    ]);
    expect(skipped).toEqual([]);
  });

  test("skips the install when the registry did not answer, and marks the miss blocking", () => {
    const { steps, skipped } = Updater.plan(facts({ at: prod }));

    expect(steps).toEqual([]);
    expect(skipped).toEqual([
      {
        label: "install",
        reason: "the npm registry could not be reached",
        blocking: true,
      },
    ]);
  });
});
