import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function statOrThrow(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    const errorCode = code(error);

    if (errorCode === "ENOENT") {
      throw new Error(await renderMissing(path));
    }

    if (errorCode === "EACCES" || errorCode === "EPERM") {
      throw new Error(`Permission denied accessing ${path}.`);
    }

    throw new Error(
      `Cannot stat ${path}: ${errorCode ?? (error instanceof Error ? error.message : "unknown error")}.`
    );
  }
}

async function renderMissing(path: string): Promise<string> {
  const suggestions = await suggestSiblings(path);
  const headline = `Path not found: ${path}. Use glob to locate the file or directory, or verify the path.`;
  if (suggestions.length === 0) {
    return headline;
  }
  return [headline, "", "Did you mean one of these?", ...suggestions].join(
    "\n"
  );
}

async function suggestSiblings(path: string): Promise<readonly string[]> {
  const dir = dirname(path);
  const base = basename(path).toLowerCase();
  const stem = base.slice(0, base.length - extname(base).length);

  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => {
        const lower = entry.toLowerCase();
        const lowerStem = lower.slice(0, lower.length - extname(lower).length);
        return (
          lower.includes(base) ||
          base.includes(lower) ||
          (stem.length > 0 &&
            (lowerStem.includes(stem) || stem.includes(lowerStem)))
        );
      })
      .slice(0, 3)
      .map((entry) => join(dir, entry));
  } catch {
    return [];
  }
}

export const FsErrors = { code, statOrThrow, renderMissing };
