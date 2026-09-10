import { expect, test } from "bun:test";

import { Surfaces, type SurfaceName } from "./Surfaces";

type Case = readonly [string, ReadonlyArray<SurfaceName>];

test("a bare daemon serves both surfaces", () => {
  expect(Surfaces.parse(["--mode", "daemon"])).toEqual(["web", "telegram"]);
});

test.each<Case>([
  ["web", ["web"]],
  ["telegram", ["telegram"]],
  ["web,telegram", ["web", "telegram"]],
  ["telegram,web", ["web", "telegram"]],
  [" web , telegram ", ["web", "telegram"]],
  ["web,web", ["web"]],
])("--surfaces %s serves %p", (requested, expected) => {
  expect(Surfaces.parse(["--surfaces", requested])).toEqual(expected);
});

test.each(["web", "telegram"])(
  "--mode %s is the single-surface spelling of --surfaces",
  (mode) => {
    expect(Surfaces.parse(["--mode", mode])).toEqual([mode]);
  }
);

test("an explicit --surfaces outranks the mode it was started in", () => {
  expect(Surfaces.parse(["--mode", "web", "--surfaces", "telegram"])).toEqual([
    "telegram",
  ]);
});

test("--surfaces=value parses the same as --surfaces value", () => {
  expect(Surfaces.parse(["--surfaces=telegram"])).toEqual(["telegram"]);
});

test.each(["", "browser", "web,browser"])(
  "refuses --surfaces %p rather than starting nothing",
  (requested) => {
    expect(() => Surfaces.parse(["--surfaces", requested])).toThrow(
      "--surfaces takes a comma-separated list of web, telegram"
    );
  }
);

test("the interactive terminal, which names no mode, is not a surface list", () => {
  expect(Surfaces.parse([])).toEqual(["web", "telegram"]);
});
