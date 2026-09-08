import { FsErrors } from "./FsErrors";
import { Paths } from "./Paths";

/** Telegram's document ceiling, borrowed so one number governs every send. */
const MAX_BYTES = 50 * 1024 * 1024;

async function validate(
  rawPath: string,
  cwd: string
): Promise<{ readonly path: string; readonly size: number }> {
  const path = Paths.resolve(rawPath, cwd);
  const st = await FsErrors.statOrThrow(path);
  if (!st.isFile()) {
    throw new Error(`${rawPath} is not a regular file.`);
  }
  if (st.size > MAX_BYTES) {
    throw new Error(
      `${rawPath} is ${st.size} bytes; max allowed is ${MAX_BYTES}.`
    );
  }
  return { path, size: st.size };
}

export const SendFile = { MAX_BYTES, validate };
