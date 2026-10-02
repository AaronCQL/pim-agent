import { expect, test } from "bun:test";

import type { ServerEvent } from "#protocol/ServerEvent";
import {
  SessionCatalogue,
  type SessionCatalogueDeps,
} from "./SessionCatalogue";

test("an unfiltered listing forgets the activity of a session that is gone", async () => {
  const announced: ServerEvent[] = [];
  const catalogue = new SessionCatalogue({
    registry: { list: async () => [] },
    cursors: { prune: async () => {} },
    meta: {
      sessions: async () => new Map(),
      pinning: async () => ({ projects: new Map(), order: [] }),
      prune: async () => {},
    },
    liveStatus: () => undefined,
    liveSessionIds: () => [],
    isBeingRead: () => false,
    announce: (event: ServerEvent) => announced.push(event),
  } as unknown as SessionCatalogueDeps);

  catalogue.onStatus("gone", "streaming");
  await catalogue.list({ type: "list_sessions" } as never);
  catalogue.onStatus("gone", "streaming");

  expect(announced).toHaveLength(2);
});
