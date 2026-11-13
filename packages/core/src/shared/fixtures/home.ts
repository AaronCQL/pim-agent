import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PimHome = { readonly path: string };

export type XdgConfigHome = { readonly path: string };

function useTempDirIn(
  variable: "PIM_HOME_DIR" | "XDG_CONFIG_HOME",
  prefix: string
): { readonly path: string } {
  let path = "";
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env[variable];
    path = await mkdtemp(join(tmpdir(), prefix));
    process.env[variable] = path;
  });

  afterAll(async () => {
    if (previous === undefined) {
      delete process.env[variable];
    } else {
      process.env[variable] = previous;
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

/**
 * A temp `PIM_HOME_DIR` for one suite, registered as that suite's own hooks.
 * `path` is only readable once `beforeAll` has run, so read it inside a test.
 */
export function usePimHome(prefix: string): PimHome {
  return useTempDirIn("PIM_HOME_DIR", prefix);
}

/** A temp `XDG_CONFIG_HOME` for one suite, like `usePimHome`. */
export function useXdgConfigHome(prefix: string): XdgConfigHome {
  return useTempDirIn("XDG_CONFIG_HOME", prefix);
}
