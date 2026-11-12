import { type Static, Type } from "typebox";

import type { ProcOwner } from "../../shared/Proc";
import { StringEnum } from "../../shared/StringEnum";
import type { SubagentDetails } from "./subagent";
import type { JobView } from "./SubagentJobs";
import type { SubagentResultDetails } from "./SubagentResult";

export const SUBAGENT_ACTIONS = ["spawn", "status", "stop", "steer"] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

export const subagentSchema = Type.Object({
  action: StringEnum(SUBAGENT_ACTIONS, {
    description:
      "spawn: start a task. status: list running jobs, or detail job `id`. stop: stop job `id` and return its result directly. steer: send job `id` a message.",
  }),
  prompt: Type.Optional(
    Type.String({
      minLength: 1,
      description: "spawn: the complete, self-contained task.",
    })
  ),
  id: Type.Optional(
    Type.String({
      minLength: 1,
      description: "status/stop/steer: the job's handle spawn returned (j1).",
    })
  ),
  message: Type.Optional(
    Type.String({
      minLength: 1,
      description: "steer: what to tell the running job.",
    })
  ),
  reason: Type.Optional(
    Type.String({
      minLength: 1,
      description: "stop: why, in a few words.",
    })
  ),
});

export type SubagentInput = Static<typeof subagentSchema>;

/** Synchronous mode has no jobs to act on, so its only input is the task. */
export const syncSubagentSchema = Type.Object({
  prompt: Type.String({
    minLength: 1,
    description: "The complete, self-contained task.",
  }),
});

/** Arguments as old sessions stored them, before `action` existed. */
export type SubagentArgs = Partial<SubagentInput>;

export type JobOwner = ProcOwner;

export type SpawnDetails = {
  readonly action: "spawn";
  readonly jobId: string;
  readonly handle: string;
  readonly prompt: string;
  readonly owner: JobOwner;
};

export type StatusDetails = {
  readonly action: "status";
  readonly jobs: readonly JobView[];
  readonly id?: string;
};

export type StopDetails = {
  readonly action: "stop";
  readonly jobIds: readonly string[];
  readonly reason: string;
  readonly result?: SubagentResultDetails;
};

export type SteerDetails = {
  readonly action: "steer";
  readonly jobId: string;
  readonly message: string;
};

export type JobActionDetails =
  | SpawnDetails
  | StatusDetails
  | StopDetails
  | SteerDetails;

/** A tool result's details, if they record a spawn. */
export function spawnOf(details: unknown): SpawnDetails | undefined {
  const spawn = details as Partial<SpawnDetails> | null | undefined;
  return spawn?.action === "spawn" && typeof spawn.jobId === "string"
    ? (spawn as SpawnDetails)
    : undefined;
}

/** A synchronous run's details carry no `action`; that includes every old session's. */
export type SubagentToolDetails = SubagentDetails | JobActionDetails;
