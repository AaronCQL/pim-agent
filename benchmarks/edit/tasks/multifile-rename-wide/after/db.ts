import { LOG_TAG } from "./logger";

export function logDb(msg: string): void {
  console.log(`${LOG_TAG} db ${msg}`);
}
