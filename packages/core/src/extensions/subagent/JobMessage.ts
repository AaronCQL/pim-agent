import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { SubagentNotice, type SubagentNoticeMessage } from "./SubagentNotice";
import {
  SubagentResult,
  type CustomMessageLike,
  type SubagentResultMessage,
} from "./SubagentResult";

/** What a job sends its parent: one notice while it runs, at most, then its result. */
export type JobMessage = SubagentResultMessage | SubagentNoticeMessage;

/** `landed`: already on the branch. `due`: append it now. `elsewhere`: its spawn is on another branch, so it waits until that branch is current again. */
export type Placement = "landed" | "due" | "elsewhere";

/** What `JobMessage.placement` reads of a session. */
export type SessionBranches = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getEntries"
>;

/** The job a `subagent_result` or `subagent_notice` names. */
function jobIdOf(message: CustomMessageLike): string | undefined {
  return (
    SubagentResult.detailsOf(message) ?? SubagentNotice.detailsOf(message)
  )?.jobId;
}

/** Tells a job's notice from its result. */
function key(message: JobMessage): string {
  return `${message.customType}:${message.details.jobId}`;
}

/** `key`, for a custom message that may not be a job's. */
function keyOf(message: CustomMessageLike): string | undefined {
  const jobId = jobIdOf(message);
  return jobId === undefined ? undefined : `${message.customType}:${jobId}`;
}

/** A result covers its job's notice too. */
function covers(entry: SessionEntry, message: JobMessage): boolean {
  if (entry.type !== "custom_message") {
    return false;
  }
  const jobId = message.details.jobId;
  return (
    SubagentResult.jobIdOf(entry) === jobId ||
    (message.customType === SubagentNotice.CUSTOM_TYPE &&
      SubagentNotice.detailsOf(entry)?.jobId === jobId)
  );
}

function spawned(entry: SessionEntry, jobId: string): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    entry.message.toolCallId === jobId
  );
}

/** Where this message belongs. Check it right before appending, with no await between. */
function placement(session: SessionBranches, message: JobMessage): Placement {
  const branch = session.getBranch();
  if (branch.some((entry) => covers(entry, message))) {
    return "landed";
  }
  const jobId = message.details.jobId;
  const away =
    !branch.some((entry) => spawned(entry, jobId)) &&
    session.getEntries().some((entry) => spawned(entry, jobId));
  return away ? "elsewhere" : "due";
}

export const JobMessage = { key, keyOf, placement };
