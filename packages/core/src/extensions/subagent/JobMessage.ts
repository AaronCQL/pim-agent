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

/** What a job sends its parent: a notice per context level while it runs, then its result. */
export type JobMessage = SubagentResultMessage | SubagentNoticeMessage;

/** `landed`: already on the branch. `due`: append it now. `elsewhere`: its spawn is on another branch, so it waits until that branch is current again. */
export type Placement = "landed" | "due" | "elsewhere";

/** What `JobMessage.placement` reads of a session. */
export type SessionBranches = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getEntries"
>;

/** Tells a job's notices apart from each other and from its result. */
function keyOf(message: CustomMessageLike): string | undefined {
  const result = SubagentResult.detailsOf(message);
  if (result !== undefined) {
    return `${message.customType}:${result.jobId}`;
  }
  const notice = SubagentNotice.detailsOf(message);
  return notice === undefined
    ? undefined
    : `${message.customType}:${notice.jobId}:${SubagentNotice.level(notice)}`;
}

function key(message: JobMessage): string {
  return keyOf(message)!;
}

/** A result covers its job's notices too, and a notice those of lower levels. */
function covers(entry: SessionEntry, message: JobMessage): boolean {
  const jobId = message.details.jobId;
  if (SubagentResult.jobIdOf(entry) === jobId) {
    return true;
  }
  if (entry.type !== "custom_message") {
    return false;
  }
  const wanted = SubagentNotice.detailsOf(message);
  const landed = SubagentNotice.detailsOf(entry);
  if (wanted === undefined || landed?.jobId !== jobId) {
    return false;
  }
  const reached = SubagentNotice.level(landed);
  return reached === "full" || reached === SubagentNotice.level(wanted);
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
