import { describe, expect, test } from "bun:test";

import { EventLog } from "../../../core/src/session/EventLog";
import { SessionProjection } from "../../../server/src/SessionProjection";
import type { DurableEvent } from "../../../protocol/src/ServerEvent";
import { FIXTURE_CWD, FIXTURE_EVENTS, FIXTURE_JSONL } from "./fixture";
import { pimTools } from "./tools";

// Registers each tool's `toViewModel`, which is what the projection paints with.
pimTools();

async function committed(): Promise<readonly DurableEvent[]> {
  return (await Bun.file(FIXTURE_EVENTS).json()) as readonly DurableEvent[];
}

describe("static replay fixture", () => {
  test("events.json is exactly what SessionProjection makes of the log", async () => {
    const projection = new SessionProjection(FIXTURE_JSONL, () => FIXTURE_CWD);
    await projection.drain();

    expect(projection.since(0)).toEqual([...(await committed())]);
  });

  test("seq is the physical line ordinal of the log it came from", async () => {
    const lines = await new EventLog(FIXTURE_JSONL).read();
    const events = await committed();

    expect(events.at(-1)?.seq).toBe(lines.at(-1)?.seq ?? 0);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq).sort((a, b) => a - b)
    );
  });

  /** The fixture only earns its place if it covers what the painter must draw. */
  test("the session exercises tool calls, a diff, an error and markdown", async () => {
    const events = await committed();
    const views = events.flatMap((event) =>
      event.type === "tool_result" ? [event] : []
    );

    expect(views.map((event) => event.name)).toEqual(["read", "edit", "bash"]);
    expect(views.some((event) => event.isError)).toBe(true);
    expect(
      JSON.stringify(views.find((event) => event.name === "edit")?.view)
    ).toContain('"kind":"diff"');

    const last = events.at(-1);
    expect(last?.type === "message" && last.role).toBe("assistant");
    expect(last?.type === "message" && last.text).toContain("| function |");
  });
});
