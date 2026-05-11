import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class Paths {
  public static resolve(value: string, baseDir: string): string {
    const expanded = Paths.expandHome(value);
    return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  }

  public static toForwardSlashes(path: string): string {
    return sep === "/" ? path : path.split(sep).join("/");
  }

  public static expandHome(value: string): string {
    if (value === "~") {
      return homedir();
    }

    if (value.startsWith("~/")) {
      return resolve(homedir(), value.slice(2));
    }

    return value;
  }

  public static abbreviateHome(path: string): string {
    const home = homedir();
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  }

  public static displayRelative(path: string, cwd: string): string {
    const rel = relative(cwd, path);

    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return path;
    }

    return rel;
  }

  public static titleOr(
    path: string | undefined,
    cwd: string,
    placeholder = "..."
  ): string {
    return path ? Paths.displayRelative(path, cwd) : placeholder;
  }
}
