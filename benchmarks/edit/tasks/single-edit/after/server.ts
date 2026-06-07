export const DEFAULT_TIMEOUT_MS = 60000;

export function connect(host: string): void {
  console.log(`connecting to ${host} (timeout ${DEFAULT_TIMEOUT_MS}ms)`);
}
