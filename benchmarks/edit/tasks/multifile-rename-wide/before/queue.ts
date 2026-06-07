import { LOG_PREFIX } from "./logger";

export function logQueue(msg: string): void {
  console.log(`${LOG_PREFIX} queue ${msg}`);
}
