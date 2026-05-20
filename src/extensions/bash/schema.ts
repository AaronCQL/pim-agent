import { type Static, Type } from "typebox";

export const STREAM_HEAD_BYTES = 4096;
export const STREAM_TAIL_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const KILL_GRACE_MS = 2000;
export const DRAIN_GRACE_MS = 2000;

export const bashSchema = Type.Object({
  command: Type.String({
    description: "Runs via bash -lc, so login shell init applies.",
  }),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}). After timeout the process gets a ${KILL_GRACE_MS / 1000}s grace period before SIGKILL.`,
    })
  ),
});
export type BashInput = Static<typeof bashSchema>;

export type CapturedStream = {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
};

export type BashCommandResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
};

export type BashStreamDetails = {
  readonly totalBytes: number;
  readonly truncated: boolean;
};

export type BashDetails = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdout: BashStreamDetails;
  readonly stderr: BashStreamDetails;
};
