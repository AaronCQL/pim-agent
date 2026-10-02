import ky, { type KyInstance } from "ky";

export type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

/** Retries off: ky's default honours `Retry-After` uncapped and can stall a tool for hours. */
export function createKy(custom?: HttpFetch): KyInstance {
  return ky.create({
    retry: 0,
    ...(custom === undefined ? {} : { fetch: custom as typeof fetch }),
  });
}
