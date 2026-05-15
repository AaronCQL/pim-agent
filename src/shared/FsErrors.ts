import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

export class FsErrors {
  public static code(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  }

  public static async statOrThrow(path: string): Promise<Stats> {
    try {
      return await stat(path);
    } catch (error) {
      const code = FsErrors.code(error);

      if (code === "ENOENT") {
        throw new Error(
          `Path not found: ${path}. Use glob to locate the file or directory, or verify the path.`
        );
      }

      if (code === "EACCES" || code === "EPERM") {
        throw new Error(`Permission denied accessing ${path}.`);
      }

      throw new Error(
        `Cannot stat ${path}: ${code ?? (error instanceof Error ? error.message : "unknown error")}.`
      );
    }
  }
}
