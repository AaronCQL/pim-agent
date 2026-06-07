import { API_BASE_URL, TIMEOUT_MS } from "./config";

export function request(path: string): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}
