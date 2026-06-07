import { LOG_PREFIX } from "./logger";

export function logHttp(msg: string): void {
  console.log(`${LOG_PREFIX} http ${msg}`);
}
