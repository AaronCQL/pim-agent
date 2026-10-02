import type { Unit } from "./Supervisor";

export const DaemonUnit = {
  mode: "daemon",
  description: "Pim daemon",
} satisfies Unit;

/** Legacy per-surface units, removed on install. */
export const SupersededUnits: ReadonlyArray<Unit> = [
  { mode: "web", description: "Pim web daemon" },
  { mode: "telegram", description: "Pim Telegram daemon" },
];
