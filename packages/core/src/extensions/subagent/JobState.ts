export type JobState = "done" | "failed" | "stopped" | "interrupted";

/** The job ended without its answer. */
function isError(state: JobState): boolean {
  return state === "failed" || state === "interrupted";
}

export const JobState = { isError };
