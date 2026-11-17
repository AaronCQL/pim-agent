import { existsSync } from "node:fs";

import { spawnOf, type SubagentArgs } from "#core/extensions/subagent/schema";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import type { SubagentChildView } from "#protocol/ServerEvent";

type Call = {
  readonly name: string;
  readonly callId: string;
  readonly args: unknown;
  readonly details: unknown;
  /** Executing now: `watch_subagent` accepts it before its log exists. */
  readonly running: boolean;
  /** The session the call ran in; without it, no run owns a log. */
  readonly sessionId: string | undefined;
};

/** `{ child }` exactly when `watch_subagent` would accept the call; `{}` otherwise, so no row offers a watch that fails. */
function of(call: Call): { readonly child?: SubagentChildView } {
  const child = childOf(call);
  return child === undefined ? {} : { child };
}

/** A spawn's details name its job. Any other run is watchable while it executes or once it wrote a log: not while its call is still streaming or queued, nor after a spawn that failed. */
function childOf({
  name,
  callId,
  args,
  details,
  running,
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
  return running || logged(sessionId, callId) ? { jobId: callId } : undefined;
}

function logged(sessionId: string | undefined, callId: string): boolean {
  const path =
    sessionId === undefined ? null : SubagentLogs.pathFor(sessionId, callId);
  return path !== null && existsSync(path);
}

export const SubagentChild = { of };
