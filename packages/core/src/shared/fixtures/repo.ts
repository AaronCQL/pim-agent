import { Proc } from "../Proc";

/**
 * An identity for every commit, so a fixture repository needs no `git config`
 * pass of its own and never picks one up from the machine running the test.
 */
const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "pim",
  GIT_AUTHOR_EMAIL: "pim@example.com",
  GIT_COMMITTER_NAME: "pim",
  GIT_COMMITTER_EMAIL: "pim@example.com",
};

/** Runs one git command in `cwd`, saying nothing whether it worked or not. */
export async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
): Promise<void> {
  await Proc.run(["git", ...args], {
    cwd,
    stdout: "pipe",
    env: { ...IDENTITY, ...env },
  });
}

/**
 * A repository on `main` with one commit, and a `branches` for every other
 * branch wanted — each an empty commit of its own, so the newest is current
 * and switching between them never touches the working tree.
 */
export async function makeRepo(
  cwd: string,
  branches: readonly string[] = []
): Promise<void> {
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["commit", "--allow-empty", "-m", "first"]);
  for (const branch of branches) {
    await git(cwd, ["checkout", "-b", branch]);
    await git(cwd, ["commit", "--allow-empty", "-m", branch]);
  }
}
