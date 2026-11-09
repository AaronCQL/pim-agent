import { expect, spyOn, test } from "bun:test";

import {
  HeldSession,
  parent,
} from "#core/extensions/subagent/fixtures/session";
import { startSubagent } from "#core/extensions/subagent/subagent";
import { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import { until } from "#core/shared/fixtures/wait";
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
  const daemon = new Daemon(
    [
      web.surface,
      broken("telegram", "409: terminated by other getUpdates request"),
    ],
    new SubagentJobs()
  );

  expect(await daemon.start()).toEqual(["web"]);
  expect(errors.mock.calls[0]?.[0]).toBe(
    "[daemon] the telegram surface failed:"
  );
  errors.mockRestore();
});

test("stops only the surfaces that came up, and never asks the failed one", async () => {
  const errors = silenceErrors();
  const web = working("web");
  const daemon = new Daemon(
    [web.surface, broken("telegram", "no token")],
    new SubagentJobs()
  );

  await daemon.start();
  await daemon.stop();

  expect(web.stopped()).toBe(true);
  expect(daemon.running).toEqual([]);
  errors.mockRestore();
});

test("a surface that throws on stop does not strand the other one", async () => {
  const errors = silenceErrors();
  const telegram = working("telegram");
  const daemon = new Daemon(
    [
      {
        name: "web",
        start: async () => ({
          stop: async () => {
            throw new Error("gateway stop hung");
          },
        }),
      },
      telegram.surface,
    ],
    new SubagentJobs()
  );

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
  const daemon = new Daemon(
    [broken("web", "EADDRINUSE"), broken("telegram", "no token")],
    new SubagentJobs()
  );

  await expect(daemon.start()).rejects.toThrow(
    "no surface started: web, telegram"
  );
  errors.mockRestore();
});

test("stops every background subagent before any surface stops", async () => {
  const jobs = new SubagentJobs();
  const child = new HeldSession();
  jobs.spawn("parent-1", {
    callId: "call-1",
    prompt: "audit the parser",
    lastHandle: 0,
    start: (onChange) =>
      startSubagent("audit the parser", parent, {
        createSession: async () => child,
        onChange,
      }),
  });
  await until(() => child.promptCalls === 1, "the child to be prompted");
  let runningAtStop: boolean | undefined;
  const daemon = new Daemon(
    [
      {
        name: "web",
        start: async () => ({
          stop: async () => {
            runningAtStop = jobs.hasRunning("parent-1");
          },
        }),
      },
    ],
    jobs
  );

  await daemon.start();
  await daemon.stop();

  expect(child.abortCalls).toBe(1);
  expect(runningAtStop).toBe(false);
});
