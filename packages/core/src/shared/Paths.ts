import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve as pathResolve, sep } from "node:path";

function pimHomeDir(): string {
  return expandHome(process.env.PIM_HOME_DIR ?? "~/.pim");
}

async function ensurePimHome(): Promise<string> {
  const dir = pimHomeDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

function resolve(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : pathResolve(baseDir, expanded);
}

function toForwardSlashes(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return pathResolve(homedir(), value.slice(2));
  }

  return value;
}

function abbreviateHome(path: string): string {
  const home = homedir();
  if (!home || !(path === home || path.startsWith(home + sep))) {
    return path;
  }
  return `~${path.slice(home.length)}`;
}

function displayRelative(path: string, cwd: string): string {
  const rel = relative(cwd, path);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return path;
  }

  return rel;
}

/** Whether `child` is `parent` or below it, by whole path segments. */
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** A relative path with no empty, `.` or `..` segment, so it names one place below whatever it is joined to. */
function isNormalRelative(path: string): boolean {
  return (
    !isAbsolute(path) &&
    path
      .split(/[/\\]/)
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function titleOr(
  path: string | undefined,
  cwd: string,
  placeholder = "..."
): string {
  return path ? displayRelative(path, cwd) : placeholder;
}

export const Paths = {
  pimHomeDir,
  ensurePimHome,
  resolve,
  toForwardSlashes,
  expandHome,
  abbreviateHome,
  displayRelative,
  titleOr,
  within,
  isNormalRelative,
  compare,
};
