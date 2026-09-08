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
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function displayRelative(path: string, cwd: string): string {
  const rel = relative(cwd, path);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return path;
  }

  return rel;
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
};
