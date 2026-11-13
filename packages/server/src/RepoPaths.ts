import { Paths } from "#core/shared/Paths";
import type { ChangeList, FileDiff, FileLines } from "#protocol/Diff";

/** A cwd-relative path as git sees it from `repo`, which is relative to the cwd. */
function inward(repo: string, path: string): string {
  if (!Paths.isNormalRelative(path)) {
    throw new Error(`${path} is not a path inside the working directory`);
  }
  if (repo === "") {
    return path;
  }
  if (!path.startsWith(`${repo}/`)) {
    throw new Error(`${path} is outside the repository ${repo}`);
  }
  return path.slice(repo.length + 1);
}

function label(repo: string): string {
  return repo === "" ? "the working directory" : repo;
}

function outward(repo: string, path: string): string {
  return repo === "" ? path : `${repo}/${path}`;
}

function changes(repo: string, list: ChangeList): ChangeList {
  return {
    ...list,
    files: list.files.map((file) => ({
      ...file,
      path: outward(repo, file.path),
      ...(file.oldPath === undefined
        ? {}
        : { oldPath: outward(repo, file.oldPath) }),
    })),
  };
}

/** Runs `read` on `path` as `repo` sees it, and names the path as the cwd does in its answer and its errors. */
async function located<T extends FileDiff | FileLines>(
  repo: string,
  path: string,
  read: (inner: string) => Promise<T>
): Promise<T> {
  const inner = inward(repo, path);
  try {
    const value = await read(inner);
    return { ...value, path: outward(repo, value.path) };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    throw new Error(
      message
        .split(" ")
        .map((word) => (word === inner ? path : word))
        .join(" "),
      { cause: err }
    );
  }
}

export const RepoPaths = { inward, changes, located, label };
