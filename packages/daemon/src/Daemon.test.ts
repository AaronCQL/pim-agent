import { expect, spyOn, test } from "bun:test";

import { Daemon, type Surface, type SurfaceHandle } from "./Daemon";
import type { SurfaceName } from "./Surfaces";

type Fake = {
  readonly surface: Surface;
  readonly stopped: () => boolean;
};

function working(name: SurfaceName): Fake {
  let stopped = false;
  return {
    stopped: () => stopped,
    surface: {
      name,
      start: async (): Promise<SurfaceHandle> => ({
        stop: async () => {
          stopped = true;
        },
      }),
    },
  };
}

function broken(name: SurfaceName, message: string): Surface {
  return {
    name,
    start: async () => {
      throw new Error(message);
    },
  };
}

function silenceErrors(): ReturnType<typeof spyOn<Console, "error">> {
  return spyOn(console, "error").mockImplementation(() => {});
}

test("a surface that throws on start leaves the others serving", async () => {
  const errors = silenceErrors();
  const web = working("web");
  const daemon = new Daemon([
    web.surface,
    broken("telegram", "409: terminated by other getUpdates request"),
  ]);

  expect(await daemon.start()).toEqual(["web"]);
  expect(errors.mock.calls[0]?.[0]).toBe(
    "[daemon] the telegram surface failed:"
  );
  errors.mockRestore();
});

test("a web surface that cannot bind leaves the bot polling", async () => {
  const errors = silenceErrors();
  const telegram = working("telegram");
  const daemon = new Daemon([
    broken("web", "EADDRINUSE: address already in use"),
    telegram.surface,
  ]);

  expect(await daemon.start()).toEqual(["telegram"]);
  errors.mockRestore();
});

test("stops only the surfaces that came up, and never asks the failed one", async () => {
  const errors = silenceErrors();
  const web = working("web");
  const daemon = new Daemon([web.surface, broken("telegram", "no token")]);

  await daemon.start();
  await daemon.stop();

  expect(web.stopped()).toBe(true);
  expect(daemon.running).toEqual([]);
  errors.mockRestore();
});

test("a surface that throws on stop does not strand the other one", async () => {
  const errors = silenceErrors();
  const telegram = working("telegram");
  const daemon = new Daemon([
    {
      name: "web",
      start: async () => ({
        stop: async () => {
          throw new Error("gateway stop hung");
        },
      }),
    },
    telegram.surface,
  ]);

  await daemon.start();
  await daemon.stop();

  expect(telegram.stopped()).toBe(true);
  expect(errors.mock.calls.at(-1)?.[0]).toBe(
    "[daemon] the web surface failed to stop:"
  );
  errors.mockRestore();
});

test("a daemon whose every surface failed exits rather than idling", async () => {
  const errors = silenceErrors();
  const daemon = new Daemon([
    broken("web", "EADDRINUSE"),
    broken("telegram", "no token"),
  ]);

  expect(daemon.start()).rejects.toThrow("no surface started: web, telegram");
  errors.mockRestore();
});
