import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PickerService } from "./PickerService";

let tmp: string;
let agentDir: string;
let cwd: string;
let home: string | undefined;

async function skill(
  root: string,
  name: string,
  description: string,
  dir = ".pi"
) {
  await mkdir(join(root, dir, "skills", name), { recursive: true });
  await Bun.write(
    join(root, dir, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`
  );
}

function service(): PickerService {
  return new PickerService({ cwd: () => cwd, agentDir });
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-picker-service-"));
  agentDir = join(tmp, "agent");
  cwd = join(tmp, "work");
  home = process.env.HOME;
  process.env.HOME = join(tmp, "home");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await Bun.write(join(cwd, "src", "Renderer.ts"), "export {};\n");
  await Bun.write(join(cwd, "src", "Router.ts"), "export {};\n");
  await Bun.write(join(cwd, "README.md"), "# hi\n");
});

afterEach(async () => {
  process.env.HOME = home;
  await rm(tmp, { recursive: true, force: true });
});

test("ranks files under the session cwd", async () => {
  const items = await service().files("Rend", 10);

  expect(items[0]?.value).toBe("src/Renderer.ts");
  expect(items.every((item) => !item.value.startsWith("/"))).toBe(true);
});

test("caps the rows it answers with", async () => {
  const items = await service().files("", 2);

  expect(items).toHaveLength(2);
});

test("skills come from the session cwd, not the process cwd", async () => {
  await skill(cwd, "deploy", "Ship the thing.");
  const other = join(tmp, "other");
  await mkdir(other, { recursive: true });
  await skill(other, "migrate", "Move the data.");

  const picker = service();
  expect(picker.commands("dep").map((item) => item.value)).toEqual([
    "/skill:deploy",
  ]);

  cwd = other;
  picker.invalidate();
  expect(picker.commands("").map((item) => item.value)).toEqual([
    "/skill:migrate",
  ]);
});

test("picks up a file written after the last query once invalidated", async () => {
  const picker = service();
  expect(await picker.files("Late", 10)).toEqual([]);

  await Bun.write(join(cwd, "src", "Latecomer.ts"), "export {};\n");
  expect(await picker.files("Late", 10)).toEqual([]);

  picker.invalidate();
  expect((await picker.files("Late", 10))[0]?.value).toBe("src/Latecomer.ts");
});

test("skills also come from the `.agents` roots, the user's included", async () => {
  await skill(process.env.HOME!, "simplify", "Tidy the code.", ".agents");
  await skill(cwd, "review", "Read the diff.", ".agents");

  expect(
    service()
      .commands("")
      .map((item) => item.value)
  ).toEqual(["/skill:review", "/skill:simplify"]);
});
