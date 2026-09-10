import type { Unit } from "./Supervisor";

/** The single unit every pim surface runs inside; `--surfaces` picks which of them come up. */
export const DaemonUnit = {
  mode: "daemon",
  description: "Pim daemon",
} satisfies Unit;

/** One unit per surface, which is how pim shipped until the surfaces shared a process. */
export const SupersededUnits: ReadonlyArray<Unit> = [
  { mode: "web", description: "Pim web daemon" },
  { mode: "telegram", description: "Pim Telegram daemon" },
];
