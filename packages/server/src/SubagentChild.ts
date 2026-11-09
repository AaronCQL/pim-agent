import { existsSync } from "node:fs";

import { spawnOf, type SubagentArgs } from "#core/extensions/subagent/schema";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import type { SubagentChildView } from "#protocol/ServerEvent";

type Call = {
  readonly name: string;
  readonly callId: string;
  readonly args: unknown;
  readonly details: unknown;
  readonly settled: boolean;
  /** The session the call ran in; without it, no settled run owns a log. */
  readonly sessionId: string | undefined;
};

/** `{ child }` when the call owns, or may yet own, a subagent log; `{}` otherwise. */
function of(call: Call): { readonly child?: SubagentChildView } {
  const child = childOf(call);
  return child === undefined ? {} : { child };
}

/** A spawn's details name its job; any other run owns a log once it wrote one, which a failed spawn never did. */
function childOf({
  name,
  callId,
  args,
  details,
  settled,
  sessionId,
}: Call): SubagentChildView | undefined {
  if (name !== "subagent") {
    return undefined;
  }
  if (typeof details === "object" && details !== null && "action" in details) {
    const spawn = spawnOf(details);
    return spawn === undefined
      ? undefined
      : {
          jobId: spawn.jobId,
          ...(typeof spawn.handle === "string" ? { handle: spawn.handle } : {}),
        };
  }
  const asked = (args as SubagentArgs | undefined)?.action;
  if (asked !== undefined && asked !== "spawn") {
    return undefined;
  }
  return !settled || logged(sessionId, callId) ? { jobId: callId } : undefined;
}

function logged(sessionId: string | undefined, callId: string): boolean {
  const path =
    sessionId === undefined ? null : SubagentLogs.pathFor(sessionId, callId);
  return path !== null && existsSync(path);
}

export const SubagentChild = { of };
