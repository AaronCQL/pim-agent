import { join } from "node:path";

/**
 * The persisted session step 1 replays. `session.jsonl` is a real pi v3 log
 * written by `generate.ts`; `events.json` is that log run through
 * `SessionProjection`, which is what the browser loads — a client never parses
 * pi's storage format, and `packages/server` has no business being bundled.
 */
export const FIXTURE_DIR = join(import.meta.dir, "fixtures");
export const FIXTURE_JSONL = join(FIXTURE_DIR, "session.jsonl");
export const FIXTURE_EVENTS = join(FIXTURE_DIR, "events.json");

/** The cwd `generate.ts` ran in, and therefore the one the log records. */
export const FIXTURE_CWD = "/tmp/pim-web-fixture";
