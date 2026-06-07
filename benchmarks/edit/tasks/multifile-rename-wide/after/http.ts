import { LOG_TAG } from "./logger";

export function logHttp(msg: string): void {
  console.log(`${LOG_TAG} http ${msg}`);
}
