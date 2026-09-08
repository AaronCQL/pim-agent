import ky, { type KyInstance } from "ky";

export type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export function createKy(custom?: HttpFetch): KyInstance {
  return ky.create(
    custom === undefined ? {} : { fetch: custom as typeof fetch }
  );
}
