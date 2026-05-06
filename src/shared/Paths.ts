import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export class Paths {
  public static resolve(value: string, baseDir: string): string {
    const expanded = Paths.expandHome(value);
    return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
  }

  public static displayRelative(path: string, cwd: string): string {
    const rel = relative(cwd, path);

    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return path;
    }

    return rel;
  }

  private static expandHome(value: string): string {
    if (value === "~") {
      return homedir();
    }

    if (value.startsWith("~/")) {
      return resolve(homedir(), value.slice(2));
    }

    return value;
  }
}
