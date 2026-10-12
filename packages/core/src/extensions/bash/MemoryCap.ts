import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";

export const MEMORY_LIMIT_VAR = "PIM_BASH_MEMORY_MAX";
const DEFAULT_SHARE_OF_RAM = 0.25;
const PROBE_LIMIT = 1024 ** 3;
const UNITS = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export type MemoryScope = {
  readonly unit: string;
  readonly limitBytes: number;
  readonly argv: readonly string[];
  /** Shell run first inside the scope; makes the kernel's OOM kill take the whole command. */
  readonly prelude: string;
};

// The kernel kills the whole group on OOM, as OOMPolicy=kill would, but the unit never ends in
// Result=oom-kill, which desktops (Plasma's oom_notifier) report as "system low on memory".
// Only ever run inside our scope: anywhere else it would mark pim's own cgroup.
const OOM_GROUP_PRELUDE =
  '{ read -r __pim_cg < /proc/self/cgroup; echo 1 > "/sys/fs/cgroup${__pim_cg#0::}/memory.oom.group"; unset __pim_cg; } 2>/dev/null; ';

let supported: Promise<boolean> | null = null;
let owner: Promise<string | null> | null = null;

function limitBytes(): number | null {
  const raw = process.env[MEMORY_LIMIT_VAR]?.trim();
  if (raw === undefined || raw === "") {
    return Math.floor(totalmem() * DEFAULT_SHARE_OF_RAM);
  }
  if (/^(off|infinity|0)$/i.test(raw)) {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(raw);
  if (!match) {
    throw new Error(
      `${MEMORY_LIMIT_VAR}=${raw} is not a size: use e.g. 8G or 512M, or off to disable the limit.`
    );
  }
  const unit = (match[2] ?? "").toUpperCase() as keyof typeof UNITS;
  return Math.floor(Number(match[1]) * UNITS[unit]);
}

/** Whether MemoryMax is enforced; without memory controller delegation systemd silently ignores it. */
async function probe(): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const proc = Bun.spawn({
      cmd: [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        "--expand-environment=no",
        `--property=MemoryMax=${PROBE_LIMIT}`,
        "--",
        "sh",
        "-c",
        'read -r line < /proc/self/cgroup; cat "/sys/fs/cgroup${line#0::}/memory.max"',
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 && out.trim() === String(PROBE_LIMIT);
  } catch {
    return false;
  }
}

/** The user service pim runs in, so command scopes stop with it. */
async function findOwner(): Promise<string | null> {
  try {
    const cgroup = await readFile("/proc/self/cgroup", "utf8");
    const path = cgroup.trim().split("\n").at(-1)?.split("::")[1] ?? "";
    const unit = path.split("/").at(-1) ?? "";
    const underUserManager = path.includes("/user@");
    return underUserManager &&
      unit.endsWith(".service") &&
      !unit.startsWith("user@")
      ? unit
      : null;
  } catch {
    return null;
  }
}

/** systemd-run argv prefix for a memory-capped scope; null when capping is off or unsupported. */
async function scope(): Promise<MemoryScope | null> {
  const limit = limitBytes();
  if (limit === null || !(await (supported ??= probe()))) {
    return null;
  }
  const bindTo = await (owner ??= findOwner());
  const unit = `pim-bash-${crypto.randomUUID().slice(0, 8)}.scope`;
  return {
    unit,
    limitBytes: limit,
    prelude: OOM_GROUP_PRELUDE,
    argv: [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--expand-environment=no",
      "--collect",
      `--unit=${unit}`,
      `--property=MemoryMax=${limit}`,
      "--property=MemorySwapMax=0",
      "--property=OOMPolicy=continue",
      "--property=KillSignal=SIGKILL",
      ...(bindTo
        ? [`--property=BindsTo=${bindTo}`, `--property=After=${bindTo}`]
        : []),
      "--",
    ],
  };
}

async function systemctl(args: readonly string[]): Promise<void> {
  await Bun.spawn({
    cmd: ["systemctl", "--user", ...args],
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
}

async function stop(unit: string): Promise<void> {
  await systemctl(["--no-block", "stop", unit]);
}

export const MemoryCap = { limitBytes, scope, stop };
