import { AgentRuntime } from "#core/session/AgentRuntime";
import { Daemon, type Surface } from "./Daemon";
import { Surfaces } from "./Surfaces";
import { TelegramSurface } from "./TelegramSurface";
import { WebSurface } from "./WebSurface";

/** Every surface in this process shares one pi installation, and so one `auth.json`. */
export function build(args: ReadonlyArray<string>): ReadonlyArray<Surface> {
  const runtime = new AgentRuntime();
  return Surfaces.parse(args).map((name) =>
    name === "web"
      ? WebSurface.create(args, runtime)
      : TelegramSurface.create(args, runtime)
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

  const daemon = new Daemon(build(args));
  const running = await daemon.start();
  console.log(`[daemon] serving ${running.join(", ")}`);

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void daemon.stop().then(resolve);
      });
    }
  });
}
