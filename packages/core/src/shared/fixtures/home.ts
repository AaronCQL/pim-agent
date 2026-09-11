import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PimHome = { readonly path: string };

/**
 * A temp `PIM_HOME_DIR` for one suite, registered as that suite's own hooks.
 * `path` is only readable once `beforeAll` has run, so read it inside a test.
 */
export function usePimHome(prefix: string): PimHome {
  let path = "";
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env.PIM_HOME_DIR;
    path = await mkdtemp(join(tmpdir(), prefix));
    process.env.PIM_HOME_DIR = path;
  });

  afterAll(async () => {
    if (previous === undefined) {
      delete process.env.PIM_HOME_DIR;
    } else {
      process.env.PIM_HOME_DIR = previous;
    }
    if (path !== "") {
      await rm(path, { recursive: true, force: true });
    }
  });

  return {
    get path(): string {
      return path;
    },
  };
}
