import { join } from "node:path";

/** The persisted session step 1 replays; `events.json` is the projection the browser loads. */
export const FIXTURE_DIR = join(import.meta.dir, "fixtures");
export const FIXTURE_JSONL = join(FIXTURE_DIR, "session.jsonl");
export const FIXTURE_EVENTS = join(FIXTURE_DIR, "events.json");

/** The cwd `generate.ts` ran in, and therefore the one the log records. */
export const FIXTURE_CWD = "/tmp/pim-web-fixture";
