import { LOG_TAG } from "./logger";

export function logAuth(msg: string): void {
  console.log(`${LOG_TAG} auth ${msg}`);
}
