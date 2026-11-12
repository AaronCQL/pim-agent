import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import type {
  ExtensionAPI,
  MessageRenderer,
  TerminalInputHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  assistant,
  FakeSession,
  HeldSession,
  parent,
  usage,
  withWindow,
} from "#core/extensions/subagent/fixtures/session";
import type { JobMessage } from "#core/extensions/subagent/JobMessage";
import { startSubagent } from "#core/extensions/subagent/subagent";
import {
  type JobView,
  SubagentJobs,
} from "#core/extensions/subagent/SubagentJobs";
import type { SubagentResultMessage } from "#core/extensions/subagent/SubagentResult";
import { until } from "#core/shared/fixtures/wait";
import { type GateState, SessionGate } from "../session-lease/SessionGate";
import subagentJobs from "./index";
import { JobsWidget } from "./JobsWidget";

type Handler = (event: never, ctx: never) => unknown;

type SendOptions = { readonly triggerTurn?: boolean };

type Sent = {
  readonly session: string;
  readonly jobId: string;
  readonly wake: boolean;
};

type Entry =
  | {
      readonly type: "custom_message";
      readonly customType: string;
      readonly details: unknown;
    }
  | {
      readonly type: "message";
      readonly message: { readonly role: "bashExecution" };
    };

type WidgetFactory = (tui: unknown, theme: Theme) => Component;

const ESCAPE = "\x1b";
/** The Kitty keyboard protocol's Escape press, repeat and release. */
const KITTY_ESCAPE = "\x1b[27u";
const KITTY_REPEAT = "\x1b[27;1:2u";
const KITTY_RELEASE = "\x1b[27;1:3u";
const WIDTH = 80;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const previousKeybindings = getKeybindings();

beforeAll(() => {
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.interrupt": {
        defaultKeys: "escape",
        description: "Cancel or abort",
      },
    })
  );
});

afterAll(() => {
  setKeybindings(previousKeybindings);
});

function editor(autocomplete = false): Component {
  return {
    actionHandlers: new Map(),
    isShowingAutocomplete: () => autocomplete,
    render: () => [],
    invalidate() {},
  } as Component;
}

function createHarness() {
  const clock = { now: 1_000 };
  const grace = Promise.withResolvers<void>();
  const jobs = new SubagentJobs({
    now: () => clock.now,
    grace: () => grace.promise,
  });
  const gate = new SessionGate();
  let gateState: GateState = "open";
  let gateHeld: Promise<void> | undefined;
  let probes = 0;
  gate.bind(async () => {
    probes += 1;
    await gateHeld;
    return gateState;
  });

  const ticks = new Set<() => void>();
  const factory = subagentJobs({
    jobs,
    gate,
    now: () => clock.now,
    every: (_ms, tick) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
  });

  const entries = new Map<string, Entry[]>();
  const sent: Sent[] = [];
  const notifications: string[] = [];
  const children = new Map<string, HeldSession>();
  let handlers = new Map<string, Handler[]>();
  const renderers = new Map<string, MessageRenderer>();
  let sessionId = "s1";
  let streaming = false;
  let turns = 0;
  let failStarts = false;
  const offBranch = new Set<Entry>();
  let widget: Component | undefined;
  let inputs: TerminalInputHandler[] = [];
  let focused: Component | null = editor();
  let editorText = "";
  let renders = 0;
  let aborts = 0;

  const tui = {
    getFocusedComponent: () => focused,
    requestRender: () => {
      renders += 1;
    },
  };

  const push = (entry: Entry): void => {
    entries.set(sessionId, [...(entries.get(sessionId) ?? []), entry]);
  };

  const append = (message: JobMessage): void => {
    push({
      type: "custom_message",
      customType: message.customType,
      details: message.details,
    });
  };

  const fileOf = (id: string): string => `/sessions/${id}.jsonl`;

  const ctx = {
    hasUI: true,
    isIdle: () => !streaming,
    // Pi's abort ends the run, which then settles.
    abort(): void {
      aborts += 1;
      void harness.settle(true);
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => fileOf(sessionId),
      getEntries: () => entries.get(sessionId) ?? [],
      getBranch: () =>
        (entries.get(sessionId) ?? []).filter((entry) => !offBranch.has(entry)),
    },
    ui: {
      notify(message: string): void {
        notifications.push(message);
      },
      setWidget(key: string, content: WidgetFactory | undefined): void {
        expect(key).toBe("pim-subagent-jobs");
        widget = content?.(tui, theme);
      },
      onTerminalInput(handler: TerminalInputHandler): () => void {
        inputs.push(handler);
        return () => {
          inputs = inputs.filter((other) => other !== handler);
        };
      },
      getEditorText: () => editorText,
    },
  };

  const emit = async (event: string, payload: object = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event, ...payload } as never, ctx as never);
    }
  };

  // Pi's idle `sendCustomMessage`: append at once, or start a run that appends once it has started.
  const sendMessage = (message: JobMessage, options: SendOptions): void => {
    expect(streaming).toBe(false);
    sent.push({
      session: sessionId,
      jobId: message.details.jobId,
      wake: options.triggerTurn === true,
    });
    if (options.triggerTurn !== true) {
      append(message);
      return;
    }
    streaming = true;
    turns += 1;
    if (!failStarts) {
      queueMicrotask(() => append(message));
    }
  };

  const load = (): void => {
    handlers = new Map();
    const api = {
      on(event: string, handler: Handler): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerMessageRenderer(type: string, render: MessageRenderer): void {
        renderers.set(type, render);
      },
      sendMessage,
    } as unknown as ExtensionAPI;
    void factory(api);
  };

  const harness = {
    jobs,
    gate,
    clock,
    sent,
    notifications,
    get session(): string {
      return sessionId;
    },
    turns: () => turns,
    aborts: () => aborts,
    probes: () => probes,
    ticking: () => ticks.size,
    renders: () => renders,
    renderer: (type = "subagent_result") => renderers.get(type),
    entries: (id = sessionId) => entries.get(id) ?? [],
    append,
    /** Records `message` on another branch of the session. */
    appendOffBranch(message: SubagentResultMessage): void {
      append(message);
      offBranch.add(entries.get(sessionId)!.at(-1)!);
    },
    failStarts(failing: boolean): void {
      failStarts = failing;
    },
    endGrace(): void {
      grace.resolve();
    },
    setGate(state: GateState): void {
      gateState = state;
    },
    /** Keeps every gate check waiting, as a slow disk would, until the returned function is called. */
    holdGate(): () => void {
      const held = Promise.withResolvers<void>();
      gateHeld = held.promise;
      return () => {
        gateHeld = undefined;
        held.resolve();
      };
    },
    setStreaming(next: boolean): void {
      streaming = next;
    },
    setFocus(component: Component | null): void {
      focused = component;
    },
    setEditorText(text: string): void {
      editorText = text;
    },
    tick(): void {
      for (const tick of ticks) {
        tick();
      }
    },
    widget(width = WIDTH): readonly string[] | undefined {
      return widget?.render(width);
    },
    async start(id = sessionId): Promise<void> {
      sessionId = id;
      load();
      await emit("session_start", { reason: "startup" });
    },
    async shutdown(reason: string, target?: string): Promise<void> {
      await emit("session_shutdown", {
        reason,
        ...(target === undefined ? {} : { targetSessionFile: fileOf(target) }),
      });
    },
    async startBash(): Promise<void> {
      await emit("user_bash", { command: "sleep 60" });
    },
    finishBash(): void {
      push({ type: "message", message: { role: "bashExecution" } });
    },
    async switchTo(id: string): Promise<void> {
      await harness.shutdown("resume", id);
      widget = undefined;
      await harness.start(id);
    },
    /** The run ends; the core subagent extension then retries the held results. */
    async settle(aborted = false): Promise<void> {
      streaming = false;
      await emit("agent_settled", { aborted });
      jobs.flush(sessionId);
    },
    key(data: string): ReturnType<TerminalInputHandler> {
      let result: ReturnType<TerminalInputHandler>;
      for (const handler of inputs) {
        result = handler(data) ?? result;
      }
      return result;
    },
    async spawn(
      callId: string,
      options: {
        readonly session?: string;
        readonly contextWindow?: number;
      } = {}
    ): Promise<HeldSession> {
      const child = new HeldSession();
      children.set(callId, child);
      jobs.spawn(options.session ?? sessionId, {
        callId,
        prompt: `task ${callId}\nwith details`,
        lastHandle: 0,
        start: (onChange) =>
          startSubagent(callId, withWindow(parent, options.contextWindow), {
            createSession: async () => child,
            onChange,
          }),
      });
      await until(() => child.promptCalls === 1, `job ${callId} to start`);
      return child;
    },
    delivered: (id = sessionId) =>
      until(() => !jobs.has(id, [...children.keys()].at(-1)!), "delivery"),
  };
  return harness;
}

type Harness = ReturnType<typeof createHarness>;

async function started(): Promise<Harness> {
  const harness = createHarness();
  await harness.start();
  return harness;
}

function view(job: Partial<JobView> = {}): JobView {
  return {
    id: "call-1",
    handle: "j1",
    title: "task",
    startedAt: 0,
    turns: 0,
    cost: 0,
    ...job,
  };
}

function plain(lines: readonly string[] | undefined): readonly string[] {
  return (lines ?? []).map((line) => Bun.stripANSI(line).trimEnd());
}

function row(stats: string, elapsed: string, width = WIDTH): string {
  const gap = width - 2 - visibleWidth(stats) - visibleWidth(elapsed);
  return ` ${stats}${" ".repeat(gap)}${elapsed}`;
}

describe("delivery", () => {
  test("a job stopped by the agent is appended without a turn", async () => {
    const harness = await started();
    await harness.spawn("call-1");

    await harness.jobs.stop("s1", "call-1", { by: "agent", reason: "done" });
    await harness.delivered();

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.turns()).toBe(0);
  });

  test("escape mid-turn keeps even a result that finished before it from waking the agent", async () => {
    const harness = await started();
    const early = await harness.spawn("early");
    await harness.spawn("late");
    harness.setStreaming(true);
    early.finish("all good");
    await until(() => harness.jobs.list("s1").length === 1, "one job left");

    expect(harness.key(ESCAPE)).toBeUndefined();
    await until(() => !harness.jobs.hasRunning("s1"), "the stop");
    await harness.settle(true);
    await until(() => harness.sent.length === 2, "both sends");

    expect(harness.sent.map((sent) => [sent.jobId, sent.wake])).toEqual([
      ["early", false],
      ["late", false],
    ]);
    expect(harness.turns()).toBe(0);
  });

  test("a result already on the branch is never sent again; one on another branch still is", async () => {
    const harness = await started();
    const rebuilt = (jobId: string): SubagentResultMessage => ({
      customType: "subagent_result",
      content: `[subagent job ${jobId} interrupted]`,
      display: true,
      details: {
        jobId,
        handle: "j1",
        prompt: "p",
        state: "interrupted",
      } as never,
    });
    harness.append(rebuilt("here"));
    harness.appendOffBranch(rebuilt("elsewhere"));

    harness.jobs.recover("s1", rebuilt("here"));
    harness.jobs.recover("s1", rebuilt("elsewhere"));
    await until(() => !harness.jobs.hasPending("s1"), "both to settle");

    expect(harness.sent.map((sent) => sent.jobId)).toEqual(["elsewhere"]);
  });

  test("a wake turn that never got to append its result leaves it for the next try", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.failStarts(true);

    child.finish("all good");
    await until(() => harness.sent.length === 1, "the send");
    harness.setStreaming(false);
    harness.failStarts(false);
    await harness.switchTo("s1");
    await until(() => harness.sent.length === 2, "the second send");
    await harness.settle();
    await harness.delivered();

    expect(harness.sent.map((sent) => sent.wake)).toEqual([true, true]);
    expect(harness.entries()).toHaveLength(1);
  });

  test("a result waits while another surface holds the session, and lands once it lets go", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setGate("held");

    child.finish("all good");
    await until(() => harness.probes() > 0, "the gate to be asked");
    await until(() => {
      harness.gate.changed();
      return harness.probes() > 1;
    }, "the gate to be asked again");

    expect(harness.sent).toEqual([]);

    harness.setGate("open");
    await until(() => {
      harness.gate.changed();
      return harness.sent.length === 1;
    }, "the send");

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: true },
    ]);
  });

  test("a stale session holds its result until the caught-up session takes it", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setGate("stale");

    child.finish("all good");
    await until(() => harness.probes() > 0, "the gate to be asked");
    harness.gate.changed();

    expect(harness.sent).toEqual([]);

    harness.setGate("open");
    await harness.switchTo("s1");
    await harness.settle();
    await harness.delivered();

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: true },
    ]);
  });

  test("a result held when the session is left is delivered once, by its next instance, without waking it", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setGate("held");
    child.finish("all good");
    await until(() => harness.probes() > 0, "the gate to be asked");

    await harness.switchTo("s2");
    harness.setGate("open");
    harness.gate.changed();
    await harness.switchTo("s1");
    await harness.delivered("s1");

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.entries("s2")).toEqual([]);
  });

  test("quitting stops every job and records each result", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");

    await harness.shutdown("quit");

    expect(child.abortCalls).toBe(1);
    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.entries()).toHaveLength(1);
  });

  test("quitting mid-turn ends the turn first, so the stopped results land without waiting out the grace", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);

    await harness.shutdown("quit");

    expect(harness.aborts()).toBe(1);
    expect(child.abortCalls).toBe(1);
    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.turns()).toBe(0);
  });

  test("quitting while idle leaves the turn alone", async () => {
    const harness = await started();
    await harness.spawn("call-1");

    await harness.shutdown("quit");

    expect(harness.aborts()).toBe(0);
  });

  test("quitting stops waiting for a child that ignores the stop once the grace runs out", async () => {
    const harness = await started();
    const stubborn = new FakeSession(() => new Promise(() => {}));
    harness.jobs.spawn("s1", {
      callId: "call-1",
      prompt: "task",
      lastHandle: 0,
      start: () =>
        startSubagent("task", parent, { createSession: async () => stubborn }),
    });
    await until(() => stubborn.promptCalls === 1, "the job to start");

    const quitting = harness.shutdown("quit");
    await until(() => stubborn.abortCalls === 1, "the stop");
    harness.endGrace();
    await quitting;

    expect(harness.widget()).toBeUndefined();
  });

  test.each([
    ["/new", "new", "s2"],
    ["/fork", "fork", "s2"],
    ["/resume of another session", "resume", "s2"],
  ])(
    "%s stops the session's jobs and records their results first",
    async (_case, reason, target) => {
      const harness = await started();
      const child = await harness.spawn("call-1");

      await harness.shutdown(reason, target);

      expect(child.abortCalls).toBe(1);
      expect(harness.jobs.has("s1", "call-1")).toBe(false);
      expect(harness.sent).toEqual([
        { session: "s1", jobId: "call-1", wake: false },
      ]);
      expect(harness.entries("s1")).toHaveLength(1);
    }
  );

  test.each([
    ["/sync", "resume", "s1"],
    ["reload", "reload", undefined],
  ])("%s keeps the session's jobs running", async (_case, reason, target) => {
    const harness = await started();
    const child = await harness.spawn("call-1");

    await harness.shutdown(reason, target);

    expect(child.abortCalls).toBe(0);
    expect(harness.jobs.hasRunning("s1")).toBe(true);
  });

  test("leaving waits for the stopped results to land", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    const release = harness.holdGate();

    const leaving = harness.shutdown("new", "s2");
    await until(() => child.abortCalls === 1, "the stop");
    await until(() => !harness.jobs.hasRunning("s1"), "the job to finish");
    release();
    await leaving;

    expect(harness.entries("s1")).toHaveLength(1);
  });

  test("leaving a session another surface holds stops its jobs but leaves their results for later", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setGate("held");

    await harness.shutdown("new", "s2");

    expect(child.abortCalls).toBe(1);
    expect(harness.sent).toEqual([]);
    expect(harness.jobs.has("s1", "call-1")).toBe(true);
  });
});

describe("widget", () => {
  test("lists running jobs, ticks while they run, and goes away with the last", async () => {
    const harness = await started();
    expect(harness.widget()).toEqual([]);

    const child = await harness.spawn("call-1");

    expect(plain(harness.widget())).toEqual([
      " 1 subagent job · escape to stop",
      row("j1: 0 turns ⬝ $0.00", "0s"),
    ]);
    expect(harness.ticking()).toBe(1);

    harness.clock.now += 61_000;
    const before = harness.renders();
    harness.tick();

    expect(harness.renders()).toBe(before + 1);
    expect(plain(harness.widget())[1]).toBe(
      row("j1: 0 turns ⬝ $0.00", "1m 1s")
    );

    child.finish("all good");
    await until(() => harness.widget()?.length === 0, "the widget to clear");

    expect(harness.ticking()).toBe(0);
  });

  test("repaints in place as a job's usage changes", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    const before = harness.renders();

    child.emit({
      type: "message_end",
      message: assistant(["working"], {
        usage: usage({ cost: { total: 0.12 } }),
        stopReason: "toolUse",
      }),
    });

    expect(harness.renders()).toBeGreaterThan(before);
    expect(plain(harness.widget())[1]).toBe(row("j1: 1 turn ⬝ $0.12", "0s"));
  });

  test("shows jobs that were already running when the session opens", async () => {
    const harness = await started();
    await harness.spawn("call-1", { session: "s2" });

    expect(harness.widget()).toEqual([]);
    expect(harness.ticking()).toBe(0);

    await harness.switchTo("s2");

    expect(plain(harness.widget())).toHaveLength(2);
    expect(harness.ticking()).toBe(1);
  });

  test("pins the elapsed time to the right edge, clipping the stats to leave it room", () => {
    const job = view({
      turns: 4,
      cost: 0.12,
      contextTokens: 50_000,
      contextWindow: 1_000_000,
    });

    const [, wide] = plain(JobsWidget.lines([job], 125_000, theme, 40));
    const [, narrow] = plain(JobsWidget.lines([job], 125_000, theme, 30));

    expect(wide).toBe(row("j1: 4 turns ⬝ $0.12 ⬝ 5.0%/1.0M", "2m 5s", 40));
    expect(narrow).toBe(row("j1: 4 turns ⬝ $0.12 ⬝…", "2m 5s", 30));
  });

  test("colours a job's context by how full it is", () => {
    const tagged = {
      ...theme,
      fg: (color: string, text: string) => `<${color}>${text}`,
    };
    const line = (contextTokens: number) =>
      JobsWidget.lines(
        [view({ contextTokens, contextWindow: 1_000_000 })],
        0,
        tagged as unknown as typeof theme,
        WIDTH
      )[1];

    expect(line(400_000)).toContain(" ⬝ 40.0%/1.0M");
    expect(line(410_000)).toContain("<warning>41.0%/1.0M");
    expect(line(700_000)).toContain("<error>70.0%/1.0M");
  });

  test("caps its rows and fits every line to the width", () => {
    const views = Array.from({ length: 7 }, (_, i) => ({
      id: `call-${i}`,
      handle: `j${i + 1}`,
      title: `a long task title number ${i} that runs well past the edge`,
      startedAt: 0,
      turns: 0,
      cost: 0,
    }));

    const lines = JobsWidget.lines(views, 5_000, theme, 40);

    expect(lines).toHaveLength(JobsWidget.MAX_ROWS + 1);
    expect(lines.at(-1)?.trim()).toBe("… +3 more");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});

describe("idle Escape", () => {
  test("stops the session's jobs and says so", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");

    expect(harness.key(ESCAPE)).toEqual({ consume: true });
    expect(harness.key(ESCAPE)).toEqual({ consume: true });
    await harness.delivered();

    expect(child.abortCalls).toBe(1);
    expect(harness.notifications).toEqual(["Stopped 1 subagent job."]);
    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
  });

  test("passes through when no job is running", async () => {
    const harness = await started();

    expect(harness.key(ESCAPE)).toBeUndefined();
  });

  test.each([
    ["autocomplete is open", (h: Harness) => h.setFocus(editor(true))],
    [
      "a selector has focus",
      (h: Harness) => h.setFocus({ render: () => [], invalidate() {} }),
    ],
    ["nothing has focus", (h: Harness) => h.setFocus(null)],
    ["the editor is in bash mode", (h: Harness) => h.setEditorText(" !ls")],
    ["a !command is running", (h: Harness) => h.startBash()],
  ])("passes through while %s", async (_case, arrange) => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    await arrange(harness);

    expect(harness.key(ESCAPE)).toBeUndefined();
    expect(child.abortCalls).toBe(0);
  });

  test("stops the jobs again once a !command has finished", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    await harness.startBash();
    harness.finishBash();

    expect(harness.key(ESCAPE)).toEqual({ consume: true });
    await until(() => child.abortCalls === 1, "the stop");
  });

  test("a !command that never records a result holds back only one Escape", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    await harness.startBash();

    expect(harness.key(ESCAPE)).toBeUndefined();
    expect(harness.key(ESCAPE)).toEqual({ consume: true });
    await until(() => child.abortCalls === 1, "the stop");
  });

  test("stops the jobs on a Kitty press, but never on its repeat or release", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");

    expect(harness.key(KITTY_REPEAT)).toBeUndefined();
    expect(harness.key(KITTY_RELEASE)).toBeUndefined();
    expect(child.abortCalls).toBe(0);

    expect(harness.key(KITTY_ESCAPE)).toEqual({ consume: true });
    await until(() => child.abortCalls === 1, "the stop");
  });

  test("an Escape that closes autocomplete does not stop the jobs on its release", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setFocus(editor(true));

    expect(harness.key(KITTY_ESCAPE)).toBeUndefined();
    harness.setFocus(editor());
    expect(harness.key(KITTY_RELEASE)).toBeUndefined();

    expect(child.abortCalls).toBe(0);
  });

  test("says so when the jobs cannot be stopped", async () => {
    const harness = await started();
    await harness.spawn("call-1");
    spyOn(harness.jobs, "stopAll").mockRejectedValue(new Error("boom"));

    expect(harness.key(ESCAPE)).toEqual({ consume: true });
    await until(() => harness.notifications.length === 1, "the notice");

    expect(harness.notifications).toEqual([
      "Could not stop the subagent jobs: boom",
    ]);
  });

  test("ignores other keys", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");

    expect(harness.key("a")).toBeUndefined();
    expect(child.abortCalls).toBe(0);
  });

  test("stops listening once the session closes", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    await harness.shutdown("reload");

    expect(harness.key(ESCAPE)).toBeUndefined();
    expect(child.abortCalls).toBe(0);
  });
});

describe("mid-turn Escape", () => {
  test("stops the session's jobs and leaves the key to pi, which cancels the turn", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);

    expect(harness.key(ESCAPE)).toBeUndefined();
    await until(() => !harness.jobs.hasRunning("s1"), "the stop");
    expect(harness.sent).toEqual([]);
    await harness.settle(true);
    await harness.delivered();

    expect(child.abortCalls).toBe(1);
    expect(harness.notifications).toEqual(["Stopped 1 subagent job."]);
    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.turns()).toBe(0);
  });

  test("stops them in bash mode or while a !command runs, as pi still cancels the turn", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    await harness.startBash();
    harness.setEditorText("!ls");
    harness.setStreaming(true);

    expect(harness.key(ESCAPE)).toBeUndefined();
    await until(() => child.abortCalls === 1, "the stop");
  });

  test("keeps a result that finished before it from waking the agent, even with no job left running", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);
    child.finish("all good");
    await until(() => !harness.jobs.hasRunning("s1"), "the job to finish");

    expect(harness.key(ESCAPE)).toBeUndefined();
    await harness.settle(true);
    await harness.delivered();

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
    expect(harness.turns()).toBe(0);
    expect(harness.notifications).toEqual([]);
  });

  test("keeps a result left over from before the session reopened from waking the agent", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);
    child.finish("all good");
    await until(() => !harness.jobs.hasRunning("s1"), "the job to finish");
    await harness.shutdown("reload");
    await harness.start();

    expect(harness.key(ESCAPE)).toBeUndefined();
    await harness.settle(true);
    await harness.delivered();

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: false },
    ]);
  });

  test("a selector that closes on the press does not stop the jobs on its release", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);
    harness.setFocus({ render: () => [], invalidate() {} });

    expect(harness.key(KITTY_ESCAPE)).toBeUndefined();
    harness.setFocus(editor());
    expect(harness.key(KITTY_RELEASE)).toBeUndefined();

    expect(child.abortCalls).toBe(0);
  });

  test.each([
    ["autocomplete is open", (h: Harness) => h.setFocus(editor(true))],
    [
      "a selector has focus",
      (h: Harness) => h.setFocus({ render: () => [], invalidate() {} }),
    ],
  ])("leaves the jobs alone while %s", async (_case, arrange) => {
    const harness = await started();
    const child = await harness.spawn("call-1");
    harness.setStreaming(true);
    arrange(harness);

    expect(harness.key(ESCAPE)).toBeUndefined();
    expect(child.abortCalls).toBe(0);
  });
});

describe("result message", () => {
  const delivered = async (
    end: (child: HeldSession) => void
  ): Promise<SubagentResultMessage> => {
    const jobs = new SubagentJobs();
    const child = new HeldSession();
    const message = Promise.withResolvers<SubagentResultMessage>();
    jobs.attach("s1", async ({ message: result }) => {
      message.resolve(result as SubagentResultMessage);
      return "landed";
    });
    jobs.spawn("s1", {
      callId: "call-1",
      lastHandle: 0,
      prompt: "Audit the auth module\nin depth",
      start: (onChange) =>
        startSubagent("audit", parent, {
          createSession: async () => child,
          onChange,
        }),
    });
    await until(() => child.promptCalls === 1, "the job to start");
    end(child);
    return await message.promise;
  };

  const render = async (
    message: SubagentResultMessage,
    expanded: boolean
  ): Promise<readonly string[]> => {
    const harness = await started();
    const component = harness.renderer()?.(
      { role: "custom", timestamp: 0, ...message },
      {
        expanded,
        outputPad: 1,
        keyText: () => "",
        keyHint: () => "",
        rawKeyHint: () => "",
      } as never,
      theme
    );
    return plain(component?.render(WIDTH));
  };

  test("renders like a subagent tool row, with the answer when expanded", async () => {
    const message = await delivered((child) =>
      child.finish("The auth module is sound.")
    );

    const collapsed = await render(message, false);
    const expanded = await render(message, true);

    expect(collapsed[0]).toBe(" ▪ Subagent: j1 ⬝ 1 turn ⬝ $0.00");
    expect(collapsed.join("\n")).not.toContain("The auth module is sound.");
    expect(expanded.join("\n")).toContain("Audit the auth module");
    expect(expanded.join("\n")).toContain("The auth module is sound.");
  });

  test("leads a failed job's body with its error", async () => {
    const message = await delivered((child) => child.fail("provider exploded"));

    expect((await render(message, true)).join("\n")).toContain(
      "provider exploded"
    );
  });

  test("renders nothing it does not understand", async () => {
    const harness = await started();

    expect(
      harness.renderer()?.(
        {
          role: "custom",
          customType: "subagent_result",
          content: "",
          display: true,
          timestamp: 0,
        },
        { expanded: false, outputPad: 1 } as never,
        theme
      )
    ).toBeUndefined();
  });
});

describe("context notice", () => {
  test("wakes an idle session once, and the job stays a running job", async () => {
    const harness = await started();
    const child = await harness.spawn("call-1", { contextWindow: 100_000 });

    child.fill(45_000);
    await until(() => harness.sent.length === 1, "the notice");
    await harness.settle();
    await until(() => !harness.jobs.hasPending("s1"), "the notice to land");
    child.fill(60_000);

    expect(harness.sent).toEqual([
      { session: "s1", jobId: "call-1", wake: true },
    ]);
    expect(harness.turns()).toBe(1);
    expect(harness.entries()).toMatchObject([
      { customType: "subagent_notice", details: { jobId: "call-1" } },
    ]);
    expect(plain(harness.widget())[0]).toBe(" 1 subagent job · escape to stop");

    child.finish("all good");
    await until(() => harness.sent.length === 2, "the result");
    await harness.settle();
    await harness.delivered();
    expect(
      harness
        .entries()
        .map((entry) => entry.type === "custom_message" && entry.customType)
    ).toEqual(["subagent_notice", "subagent_result"]);
  });

  test("renders as a subagent row, its share amber", async () => {
    const harness = await started();
    const colors: string[] = [];
    const component = harness.renderer("subagent_notice")?.(
      {
        role: "custom",
        customType: "subagent_notice",
        content: "",
        display: true,
        timestamp: 0,
        details: {
          jobId: "call-1",
          handle: "j22",
          contextTokens: 402_000,
          contextWindow: 1_000_000,
          turns: 69,
          elapsedMs: 30 * 60_000,
          cost: 9.8,
          tools: [],
        },
      },
      { expanded: true, outputPad: 1 } as never,
      {
        ...theme,
        fg: (color: string, text: string) => {
          colors.push(`${color}:${text}`);
          return text;
        },
      } as Theme
    );

    expect(plain(component?.render(WIDTH))).toEqual([
      " ▪ Subagent: j22 ⬝ context at 40%",
    ]);
    expect(colors).toContain("warning:context at 40%");
  });
});
