import { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import { AgentRuntime } from "#core/session/AgentRuntime";
import { Shutdown } from "#core/shared/Shutdown";
import { Daemon, type Surface, type SurfaceDeps } from "./Daemon";
import { Surfaces } from "./Surfaces";
import { TelegramSurface } from "./TelegramSurface";
import { WebSurface } from "./WebSurface";

export function build(
  args: ReadonlyArray<string>,
  jobs: SubagentJobs
): ReadonlyArray<Surface> {
  const deps: SurfaceDeps = { runtime: new AgentRuntime(), jobs };
  return Surfaces.parse(args).map((name) =>
    name === "web"
      ? WebSurface.create(args, deps)
      : TelegramSurface.create(args, deps)
  );
}

export async function start(args: ReadonlyArray<string>): Promise<void> {
  if (
    Surfaces.parse(args).includes("telegram") &&
    args.includes("--print-config")
  ) {
    await TelegramSurface.printConfig(args);
    return;
  }

  const jobs = new SubagentJobs();
  await serve(new Daemon(build(args, jobs), jobs));
}

/** Owns the process's signals: serves until the first one, then stops gracefully. */
export async function serve(daemon: Daemon): Promise<void> {
  const signalled = Shutdown.untilSignal();
  const running = await daemon.start();
  console.log(`[daemon] serving ${running.join(", ")}`);
  console.log(`[daemon] ${await signalled}: stopping`);
  await daemon.stop();
}
