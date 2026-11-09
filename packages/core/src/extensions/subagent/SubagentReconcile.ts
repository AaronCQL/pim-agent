import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Proc } from "../../shared/Proc";
import { SubagentLogs } from "../../shared/SubagentLogs";
import { JobLine } from "./JobLine";
import { spawnOf, type JobOwner, type SpawnDetails } from "./schema";
import type { SubagentJobs } from "./SubagentJobs";
import { SubagentResult } from "./SubagentResult";

type ParentSession = ExtensionContext["sessionManager"];

type Entries = ReturnType<ParentSession["getBranch"]>;

function owner(): JobOwner {
  return Proc.self();
}

/** Ours, or dead on this host. A job on another host is never presumed lost. */
function isGone(of: JobOwner | undefined): boolean {
  if (of === undefined) {
    return true;
  }
  if (!Proc.isLocal(of)) {
    return false;
  }
  return Proc.isSelf(of) || !Proc.isAlive(of.pid);
}

function spawns(entries: Entries): readonly SpawnDetails[] {
  return entries.flatMap((entry) => {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "subagent" ||
      entry.message.isError
    ) {
      return [];
    }
    const spawn = spawnOf(entry.message.details);
    return spawn === undefined ? [] : [spawn];
  });
}

/** The highest `jN` any spawn in `entries` was given; 0 for none. */
function lastHandle(entries: Entries): number {
  return Math.max(
    0,
    ...spawns(entries).map((spawn) => JobLine.handleNumber(spawn.handle))
  );
}

/** Hands `jobs` a result for every spawn on the branch whose job is gone without one. */
async function run(jobs: SubagentJobs, session: ParentSession): Promise<void> {
  const parentSessionId = session.getSessionId();
  const branch = session.getBranch();
  const answered = new Set(branch.map(SubagentResult.jobIdOf));
  const lost = spawns(branch).filter(
    (spawn) =>
      !answered.has(spawn.jobId) &&
      !jobs.has(parentSessionId, spawn.jobId) &&
      isGone(spawn.owner)
  );
  // Read in parallel, but recover in branch order.
  const results = await Promise.all(
    lost.map(async (spawn) => {
      const logPath = SubagentLogs.pathFor(parentSessionId, spawn.jobId);
      if (logPath === null || !(await Bun.file(logPath).exists())) {
        return undefined;
      }
      return await SubagentResult.fromLog(
        {
          jobId: spawn.jobId,
          handle: spawn.handle,
          prompt: spawn.prompt,
        },
        logPath
      );
    })
  );
  for (const result of results) {
    if (result !== undefined) {
      jobs.recover(parentSessionId, result);
    }
  }
}

export const SubagentReconcile = { owner, lastHandle, run };
