import { LOG_PREFIX } from "./logger";

export function logAuth(msg: string): void {
  console.log(`${LOG_PREFIX} auth ${msg}`);
}
