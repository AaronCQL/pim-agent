import { Format } from "./Format";
import { FsErrors } from "./FsErrors";
import { Paths } from "./Paths";

async function validate(
  rawPath: string,
  cwd: string,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<{ readonly path: string; readonly size: number }> {
  const path = Paths.resolve(rawPath, cwd);
  const st = await FsErrors.statOrThrow(path);
  if (!st.isFile()) {
    throw new Error(`${rawPath} is not a regular file.`);
  }
  if (st.size > maxBytes) {
    throw new Error(
      `${rawPath} is ${Format.bytes(st.size)}; max allowed is ${Format.bytes(maxBytes)}.`
    );
  }
  return { path, size: st.size };
}

export const SendFile = { validate };
