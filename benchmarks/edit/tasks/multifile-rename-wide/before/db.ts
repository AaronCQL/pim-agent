import { LOG_PREFIX } from "./logger";

export function logDb(msg: string): void {
  console.log(`${LOG_PREFIX} db ${msg}`);
}
