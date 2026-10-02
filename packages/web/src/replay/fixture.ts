import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dir, "fixtures");
export const FIXTURE_JSONL = join(FIXTURE_DIR, "session.jsonl");
export const FIXTURE_EVENTS = join(FIXTURE_DIR, "events.json");

/** The cwd recorded in the log by `generate.ts`. */
export const FIXTURE_CWD = "/tmp/pim-web-fixture";
