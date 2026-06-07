import { BASE_URL, TIMEOUT_MS } from "./config";

export function request(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
