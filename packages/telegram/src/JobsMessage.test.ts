import { GrammyError, type Api } from "grammy";
import { afterAll, expect, spyOn, test } from "bun:test";

import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import type { Every } from "#core/shared/Timers";
import { JobsMessage } from "./JobsMessage";

const quietLog = spyOn(console, "log").mockImplementation(() => {});
const quietWarn = spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => {
  quietLog.mockRestore();
  quietWarn.mockRestore();
});

type Call =
  | { readonly kind: "send"; readonly text: string }
  | {
      readonly kind: "edit";
      readonly messageId: number;
      readonly text: string;
    };

type RichArg = string | { readonly html: string };

class FakeApi {
  public readonly calls: Call[] = [];
  public failEdit: Error | undefined;
  public readonly lost = new Set<number>();
  public hold: Promise<void> | undefined;
  private nextId = 100;

  public async sendRichMessage(
    _chatId: number,
    rich: { readonly html: string }
  ): Promise<{ readonly message_id: number }> {
    this.calls.push({ kind: "send", text: rich.html });
    this.nextId += 1;
    return { message_id: this.nextId };
  }

  public async editMessageText(
    _chatId: number,
    messageId: number,
    text: RichArg
  ): Promise<void> {
    await this.hold;
    const failure = this.lost.has(messageId)
      ? grammyError(400, "Bad Request: message to edit not found")
      : this.failEdit;
    this.failEdit = undefined;
    if (failure !== undefined) {
      throw failure;
    }
    this.calls.push({
      kind: "edit",
      messageId,
      text: typeof text === "string" ? text : text.html,
    });
  }
}

class FakeSource {
  public jobs: readonly JobView[] = [];
  private readonly listeners = new Set<() => void>();

  public onJobsChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public set(jobs: readonly JobView[]): void {
    this.jobs = jobs;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class ManualTicker {
  public readonly intervals: number[] = [];
  private tick: (() => void) | undefined;

  public readonly every: Every = (ms, tick) => {
    this.intervals.push(ms);
    this.tick = tick;
    return () => {
      this.tick = undefined;
    };
  };

  public get running(): boolean {
    return this.tick !== undefined;
  }

  public fire(): void {
    this.tick?.();
  }
}

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "call-1",
    handle: "j1",
    title: "Review the parser",
    startedAt: 0,
    turns: 0,
    cost: 0,
    ...overrides,
  };
}

function setup(options: { readonly grace?: () => Promise<void> } = {}) {
  const api = new FakeApi();
  const source = new FakeSource();
  const ticker = new ManualTicker();
  const clock = { now: 0 };
  const message = new JobsMessage({
    api: api as unknown as Api,
    chat: { chatId: 7, threadId: undefined },
    source,
    now: () => clock.now,
    every: ticker.every,
    ...options,
  });
  return { api, source, ticker, clock, message };
}

function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(
    "edit",
    { ok: false, error_code: code, description },
    "editMessageText",
    {}
  );
}

test("sends one message when the first job starts", async () => {
  const { api, source, message } = setup();

  source.set([
    job({
      turns: 4,
      cost: 0.12,
      contextTokens: 50_000,
      contextWindow: 1_000_000,
    }),
  ]);
  await message.settled();

  expect(api.calls).toEqual([
    {
      kind: "send",
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 4 turns ⬝ $0.12 ⬝ 5.0%/1.0M ⬝ 0s",
    },
  ]);
});

test("flags a job its context notice was issued for, not one merely past the threshold", async () => {
  const { api, source, message } = setup();

  source.set([
    job({ contextTokens: 402_000, contextWindow: 1_000_000, noticed: true }),
    job({ id: "call-2", handle: "j2", contextTokens: 50, contextWindow: 100 }),
  ]);
  await message.settled();

  expect(api.calls).toEqual([
    {
      kind: "send",
      text: "🤖 <b>2 jobs running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 40.2%/1.0M ⬝ 0s ⬝ ⚠ 40%<br>• <b>j2</b>: 0 turns ⬝ $0.00 ⬝ 50.0%/100 ⬝ 0s",
    },
  ]);
});

test("refreshes on the ticker, not on every change, and only when the text moved", async () => {
  const { api, source, ticker, clock, message } = setup();
  source.set([job()]);
  await message.settled();

  source.set([job({ turns: 1 })]);
  source.set([job({ turns: 2 })]);
  await message.settled();
  expect(api.calls).toHaveLength(1);

  clock.now = 65_000;
  ticker.fire();
  await message.settled();
  ticker.fire();
  await message.settled();

  expect(ticker.intervals).toEqual([5_000]);
  expect(api.calls.slice(1)).toEqual([
    {
      kind: "edit",
      messageId: 101,
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 2 turns ⬝ $0.00 ⬝ 1m 5s",
    },
  ]);
});

test("closes the message once no job runs, and starts a new one for the next batch", async () => {
  const { api, source, ticker, message } = setup();
  source.set([job({ id: "a" }), job({ id: "b", handle: "j2" })]);
  await message.settled();

  source.set([job({ id: "b", handle: "j2" })]);
  ticker.fire();
  await message.settled();
  source.set([]);
  await message.settled();
  expect(ticker.running).toBe(false);

  source.set([job({ id: "c", handle: "j3" })]);
  await message.settled();

  expect(api.calls.map((call) => call.kind)).toEqual([
    "send",
    "edit",
    "edit",
    "send",
  ]);
  expect(api.calls[2]).toEqual({
    kind: "edit",
    messageId: 101,
    text: "🤖 2 jobs ended",
  });
  expect(api.calls[3]).toMatchObject({ kind: "send" });
  expect((api.calls[3] as { text: string }).text).toContain("<b>j3</b>");
});

test("a job that ends before its first paint leaves no message behind", async () => {
  const { api, source, message } = setup();

  source.set([job()]);
  source.set([]);
  await message.settled();

  expect(api.calls).toEqual([]);
});

test("caps the rows", async () => {
  const { api, source, message } = setup();
  const many = Array.from({ length: 12 }, (_, i) =>
    job({ id: `call-${i}`, handle: `j${i + 1}` })
  );

  source.set(many);
  await message.settled();

  const text = (api.calls[0] as { text: string }).text;
  expect(text).toContain("<b>j10</b>");
  expect(text).not.toContain("<b>j11</b>");
  expect(text.endsWith("+2 more")).toBe(true);
});

test("an unmodified or failed edit does not stop later refreshes", async () => {
  const { api, source, ticker, clock, message } = setup();
  source.set([job()]);
  await message.settled();

  api.failEdit = grammyError(400, "Bad Request: message is not modified");
  clock.now = 1_000;
  ticker.fire();
  await message.settled();
  api.failEdit = grammyError(429, "Too Many Requests");
  clock.now = 2_000;
  ticker.fire();
  await message.settled();
  clock.now = 3_000;
  ticker.fire();
  await message.settled();

  expect(api.calls.map((call) => call.text)).toEqual([
    "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 0s",
    "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 3s",
  ]);
});

test("dispose stops refreshing and listening", async () => {
  const { api, source, ticker, message } = setup();
  source.set([job()]);
  await message.settled();

  message.dispose();
  source.set([job({ turns: 1 })]);
  ticker.fire();
  await message.settled();

  expect(ticker.running).toBe(false);
  expect(api.calls).toHaveLength(1);
});

test("dispose settles once the closing edit lands", async () => {
  const { api, source, message } = setup();
  source.set([job()]);
  await message.settled();
  const edit = Promise.withResolvers<void>();
  api.hold = edit.promise;
  source.set([]);

  const disposed = Promise.resolve(message.dispose()).then(() =>
    api.calls.at(-1)
  );
  edit.resolve();

  expect(await disposed).toEqual({
    kind: "edit",
    messageId: 101,
    text: "🤖 1 job ended",
  });
});

test("dispose waits for a stuck edit only until the grace runs out", async () => {
  const grace = Promise.withResolvers<void>();
  const { api, source, message } = setup({ grace: () => grace.promise });
  source.set([job()]);
  await message.settled();
  api.hold = new Promise<void>(() => {});
  source.set([]);

  const disposed = message.dispose();
  grace.resolve();

  await disposed;
  expect(api.calls).toHaveLength(1);
});

test("counts every job of the batch when it closes, painted or not", async () => {
  const { api, source, message } = setup();
  source.set([job({ id: "a" })]);
  await message.settled();
  source.set([job({ id: "a" }), job({ id: "b" })]);

  source.set([]);
  await message.settled();

  expect(api.calls.map((call) => call.text)).toEqual([
    "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 0s",
    "🤖 2 jobs ended",
  ]);
});

test("a batch that starts while the last one closes gets its own message and count", async () => {
  const { api, source, ticker, message } = setup();
  source.set([job({ id: "a" })]);
  await message.settled();

  ticker.fire();
  source.set([]);
  source.set([job({ id: "b", handle: "j2" })]);
  await message.settled();
  source.set([]);
  await message.settled();

  expect(api.calls).toEqual([
    {
      kind: "send",
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 0s",
    },
    { kind: "edit", messageId: 101, text: "🤖 1 job ended" },
    {
      kind: "send",
      text: "🤖 <b>1 job running</b><br>• <b>j2</b>: 0 turns ⬝ $0.00 ⬝ 0s",
    },
    { kind: "edit", messageId: 102, text: "🤖 1 job ended" },
  ]);
});

test("sends a new message once Telegram has lost the old one", async () => {
  const { api, source, ticker, clock, message } = setup();
  source.set([job()]);
  await message.settled();

  api.lost.add(101);
  clock.now = 1_000;
  ticker.fire();
  await message.settled();
  clock.now = 2_000;
  ticker.fire();
  await message.settled();

  expect(api.calls).toEqual([
    {
      kind: "send",
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 0s",
    },
    {
      kind: "send",
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 1s",
    },
    {
      kind: "edit",
      messageId: 102,
      text: "🤖 <b>1 job running</b><br>• <b>j1</b>: 0 turns ⬝ $0.00 ⬝ 2s",
    },
  ]);
});

test("retries a failed closing edit once", async () => {
  const { api, source, message } = setup();
  source.set([job()]);
  await message.settled();

  api.failEdit = grammyError(502, "Bad Gateway");
  source.set([]);
  await message.settled();

  expect(api.calls.at(-1)).toEqual({
    kind: "edit",
    messageId: 101,
    text: "🤖 1 job ended",
  });
});
