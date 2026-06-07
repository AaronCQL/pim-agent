import { LOG_TAG } from "./logger";

export function logQueue(msg: string): void {
  console.log(`${LOG_TAG} queue ${msg}`);
}
