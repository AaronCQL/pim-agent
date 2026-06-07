import { LOG_PREFIX } from "./logger";

export function logCache(msg: string): void {
  console.log(`${LOG_PREFIX} cache ${msg}`);
}
