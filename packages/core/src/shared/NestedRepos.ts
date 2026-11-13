import { FileEnumerator } from "./FileEnumerator";
import { Paths } from "./Paths";
import { RepoFiles } from "./RepoFiles";

const LIMIT = 50;

/** Repository roots strictly below `cwd` that the file browser's walk reaches, as sorted cwd-relative POSIX paths. */
async function find(cwd: string): Promise<readonly string[]> {
  const { repos } = await RepoFiles.walk(cwd, RepoFiles.LIST_LIMIT);
  return repos.slice(0, LIMIT);
}

/** Throws unless `repo`, in normal relative POSIX form, is a repository root strictly inside `cwd`, symlinks resolved. */
async function verify(cwd: string, repo: string): Promise<void> {
  if (!Paths.isNormalRelative(repo)) {
    throw new Error(`${repo} is not a plain relative path`);
  }
  const target = await RepoFiles.locate(cwd, repo);
  if (!(await FileEnumerator.isRepoRoot(target))) {
    throw new Error(`${repo} is not a git repository`);
  }
}

export const NestedRepos = { find, verify, LIMIT };
