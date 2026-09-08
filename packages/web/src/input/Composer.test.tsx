import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { until } from "../test/gateway";
import { Composer } from "./Composer";

type Command = { readonly type: string } & Record<string, unknown>;

type Answer = (command: Command) => Promise<unknown> | unknown;

function attached(sessionId = "s1"): ServerEvent {
  return {
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    cwd: "/repo",
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  };
}

function sessionState(extra: Record<string, unknown> = {}): ServerEvent {
  return {
    type: "session_state",
    cwd: "/repo",
    model: "sonnet",
    thinking: "medium",
    cost: 0,
    status: "idle",
    ...extra,
  } as ServerEvent;
}

let realMatchMedia: typeof globalThis.matchMedia | undefined;
let realCreateObjectURL: typeof URL.createObjectURL;
let realRevokeObjectURL: typeof URL.revokeObjectURL;
let realFetch: typeof globalThis.fetch;

const previews: string[] = [];
const revoked: string[] = [];

function softKeyboard(): void {
  realMatchMedia ??= globalThis.matchMedia;
  const real = realMatchMedia.bind(globalThis);
  globalThis.matchMedia = ((query: string) =>
    query.includes("hover")
      ? { matches: false, addEventListener() {}, removeEventListener() {} }
      : real(query)) as typeof globalThis.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  previews.length = 0;
  revoked.length = 0;
  realCreateObjectURL = URL.createObjectURL;
  realRevokeObjectURL = URL.revokeObjectURL;
  realFetch = globalThis.fetch;
  URL.createObjectURL = (() => {
    const url = `blob:preview/${previews.length}`;
    previews.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  globalThis.fetch = realFetch;
  if (realMatchMedia) {
    globalThis.matchMedia = realMatchMedia;
    realMatchMedia = undefined;
  }
});

function offline(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
}

function answers(store: SessionStore, answer: Answer): readonly Command[] {
  const seen: Command[] = [];
  store.client.send = (async (command: Command) => {
    seen.push(command);
    const body = (await answer(command)) ?? {};
    return { type: "response", id: "1", success: true, ...body };
  }) as typeof store.client.send;
  return seen;
}

function rows(...values: readonly string[]): { readonly items: PickerItem[] } {
  return { items: values.map((value) => ({ value, label: value })) };
}

function commands(
  store: SessionStore,
  answer: (query: string) => readonly PickerItem[]
): readonly { readonly query: string; readonly limit: number | undefined }[] {
  const seen: { readonly query: string; readonly limit: number | undefined }[] =
    [];
  store.pickCommands = (async (query: string, limit?: number) => {
    seen.push({ query, limit });
    return answer(query);
  }) as typeof store.pickCommands;
  return seen;
}

function panel(host: HTMLElement): Element | undefined {
  return [...host.querySelectorAll("[popover]")].find(
    (element) => !element.className.includes("hidden")
  );
}

type Painted = {
  readonly host: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly card: HTMLElement;
  readonly trace: string[];
};

function paint(store: SessionStore, trace: string[] = []): Painted {
  const host = mountPoint();
  render(
    () => (
      <Composer
        store={store}
        onSend={() => {
          trace.push("onSend");
        }}
      />
    ),
    host
  );
  flush();
  const input = host.querySelector("textarea")!;
  return { host, input, card: input.parentElement!, trace };
}

function options(host: HTMLElement): readonly Element[] {
  const open = panel(host);
  return open === undefined
    ? []
    : [...open.querySelectorAll('[role="option"]')];
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function press(
  input: HTMLTextAreaElement,
  key: string,
  modifiers: Partial<KeyboardEvent> = {}
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  input.dispatchEvent(event);
  return event;
}

function fire(
  target: EventTarget,
  name: string,
  payload: Record<string, unknown> = {}
): Event {
  const event = new Event(name, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(payload)) {
    Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function png(name: string): File {
  return new File(["bytes"], name, { type: "image/png" });
}

type Uploads = {
  readonly started: File[];
  readonly settle: (name: string, body: unknown, ok?: boolean) => void;
};

function uploads(store: SessionStore): Uploads {
  const started: File[] = [];
  const waiting = new Map<string, (response: Response) => void>();
  globalThis.fetch = (async (_url: string, init: { body: FormData }) => {
    const file = init.body.get("file") as File;
    return new Promise<Response>((resolve) => {
      waiting.set(file.name, resolve);
    });
  }) as unknown as typeof fetch;
  const real = store.attachFile.bind(store);
  store.attachFile = ((file: File) => {
    started.push(file);
    return real(file);
  }) as typeof store.attachFile;
  return {
    started,
    settle: (name, body, ok = true) => {
      waiting.get(name)?.(Response.json(body, { status: ok ? 200 : 400 }));
      waiting.delete(name);
    },
  };
}

test("the picker closes for the token that was dismissed and opens on the next one", async () => {
  const store = offline();
  answers(store, () => rows("greeter.ts"));
  store.ingest(attached());
  const { host, input } = paint(store);

  type(input, "@gre");
  await until(() => options(host).length > 0, "the server's rows");
  expect(options(host)[0]?.textContent).toContain("greeter.ts");

  press(input, "Escape");
  flush();
  expect(options(host)).toHaveLength(0);
  expect(input.value).toBe("@gre");

  type(input, "@gret");
  await until(() => options(host).length > 0, "the picker to re-open");

  type(input, "@gre ");
  flush();
  expect(options(host)).toHaveLength(0);
  await Bun.sleep(5);
  flush();
  expect(options(host)).toHaveLength(0);
});

test("a reply that arrives after a newer one never lands", async () => {
  const store = offline();
  const held = new Map<string, () => void>();
  answers(store, async (command) => {
    const query = command.query as string;
    await new Promise<void>((resolve) => {
      held.set(query, resolve);
    });
    return rows(`${query}-row.ts`);
  });
  store.ingest(attached());
  const { host, input } = paint(store);

  type(input, "@a");
  await until(() => held.has("a"), "the first query to reach the server");
  type(input, "@ab");
  await until(() => held.has("ab"), "the second query to reach the server");

  held.get("ab")!();
  await until(() => options(host).length > 0, "the second query's rows");
  expect(options(host)[0]?.textContent).toContain("ab-row.ts");

  held.get("a")!();
  await Bun.sleep(5);
  flush();
  expect(options(host)).toHaveLength(1);
  expect(options(host)[0]?.textContent).toContain("ab-row.ts");
});

test("a slash opens only at the start of a line, and a directory keeps it open", async () => {
  const store = offline();
  answers(store, () => rows("src/", "src/index.ts"));
  commands(store, () => [{ value: "/skill", label: "/skill" }]);
  store.ingest(attached());
  const { host, input } = paint(store);

  type(input, "/ski");
  await until(() => options(host).length > 0, "the command rows");
  expect(options(host)[0]?.textContent).toContain("/skill");

  type(input, "say /ski");
  flush();
  expect(options(host)).toHaveLength(0);

  type(input, "hi\n/ski");
  await until(() => options(host).length > 0, "the command rows again");

  press(input, "Enter");
  flush();
  expect(input.value).toBe("hi\n/skill ");
  expect(options(host)).toHaveLength(0);

  type(input, "@sr");
  await until(() => options(host).length > 0, "the file rows");
  press(input, "Enter");
  flush();
  expect(input.value).toBe("@src/");
  expect(input.selectionStart).toBe(5);
  await until(() => options(host).length > 0, "the picker to stay open");
});

test("the picker asks for fifty files and twenty commands", async () => {
  const store = offline();
  const seen = answers(store, () => rows("greeter.ts"));
  const asked = commands(store, () => [{ value: "/skill", label: "/skill" }]);
  store.ingest(attached());
  const { host, input } = paint(store);

  type(input, "@gre");
  await until(() => options(host).length > 0, "the file rows");
  type(input, "/ski");
  await until(() => asked.length > 0, "the command query");

  expect(seen.find((command) => command.type === "pick_files")).toEqual({
    type: "pick_files",
    sessionId: "s1",
    query: "gre",
    limit: 50,
  });
  expect(asked).toEqual([{ query: "ski", limit: undefined }]);

  const direct = offline();
  const frames = answers(direct, () => rows("/skill"));
  direct.ingest(attached());
  flush();
  await direct.pickCommands("ski");
  expect(frames.find((command) => command.type === "pick_commands")).toEqual({
    type: "pick_commands",
    sessionId: "s1",
    query: "ski",
    limit: 20,
  });
});

test("pasting files uploads them; pasting words is left to the browser", async () => {
  const store = offline();
  answers(store, () => ({}));
  store.ingest(attached());
  const { input } = paint(store);
  const flow = uploads(store);

  const withFiles = fire(input, "paste", {
    clipboardData: { files: [png("one.png"), png("two.png")] },
  });
  expect(withFiles.defaultPrevented).toBe(true);
  await until(() => flow.started.length === 2, "both uploads to start");
  expect(flow.started.map((file) => file.name)).toEqual(["one.png", "two.png"]);

  const textOnly = fire(input, "paste", { clipboardData: { files: [] } });
  expect(textOnly.defaultPrevented).toBe(false);
  await Bun.sleep(5);
  expect(flow.started).toHaveLength(2);
});

test("a drop uploads together, previews locally, and names what failed", async () => {
  const store = offline();
  answers(store, () => ({}));
  store.ingest(attached());
  const { host, input, card } = paint(store);
  const flow = uploads(store);

  fire(card, "dragover");
  flush();
  expect(card.className).toContain("ring-indigo-400");
  expect(card.className).not.toContain("ring-neutral-700");
  fire(card, "dragleave");
  flush();
  expect(card.className).toContain("ring-neutral-700");

  fire(card, "drop", {
    dataTransfer: { files: [png("one.png"), png("two.png")] },
  });
  await until(() => flow.started.length === 2, "both uploads to start");
  flush();
  expect(card.className).toContain("ring-neutral-700");

  const tiles = (): readonly HTMLImageElement[] => [
    ...host.querySelectorAll("img"),
  ];
  expect(tiles().map((tile) => tile.getAttribute("src"))).toEqual([
    "blob:preview/0",
    "blob:preview/1",
  ]);
  expect(tiles()[0]?.className).toContain("opacity-50");

  flow.settle("one.png", {
    id: "a1",
    url: "/attachment/s1/one.png",
    isImage: true,
  });
  await until(() => store.attachmentsOf("s1").length === 1, "the stored file");
  flush();
  expect(revoked).toEqual(["blob:preview/0"]);
  expect(tiles().map((tile) => tile.getAttribute("src"))).toEqual([
    "http://127.0.0.1:1/attachment/s1/one.png",
    "blob:preview/1",
  ]);

  flow.settle("two.png", { error: "disk full" }, false);
  await until(
    () => host.textContent?.includes("two.png: disk full") === true,
    "the failure line"
  );
  flush();
  expect(revoked).toEqual(["blob:preview/0", "blob:preview/1"]);
  expect(host.querySelector<HTMLElement>("p.text-rose-400")?.textContent).toBe(
    "two.png: disk full"
  );

  const chooser = host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(chooser, "files", {
    configurable: true,
    value: [png("three.png")],
  });
  chooser.value = "";
  fire(chooser, "change");
  await until(() => flow.started.length === 3, "the chosen upload");
  expect(chooser.value).toBe("");
  flow.settle("three.png", {
    id: "a3",
    url: "/attachment/s1/three.png",
    isImage: true,
  });
  await until(() => store.attachmentsOf("s1").length === 2, "the second file");
  flush();
  expect(host.querySelector("p.text-rose-400")).toBeNull();
  expect(input.value).toBe("");
});

test("the one button sends, steers or stops, and never takes the focus", async () => {
  const store = offline();
  answers(store, () => ({}));
  const said: string[] = [];
  let release!: () => void;
  store.prompt = (async (text: string) => {
    said.push(text);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }) as typeof store.prompt;
  store.ingest(attached());
  store.ingest(sessionState());
  const trace: string[] = [];
  const { host, input } = paint(store, trace);
  const button = (label: string): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

  expect(button("Send")).not.toBeNull();
  button("Send")!.click();
  flush();
  expect(said).toEqual([]);

  type(input, "hello");
  button("Send")!.click();
  flush();
  expect(trace).toEqual(["onSend"]);
  expect(said).toEqual(["hello"]);
  expect(input.value).toBe("");
  expect(options(host)).toHaveLength(0);
  release();

  const tap = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  button("Send")!.dispatchEvent(tap);
  expect(tap.defaultPrevented).toBe(true);
  const grab = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  host
    .querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!
    .dispatchEvent(grab);
  expect(grab.defaultPrevented).toBe(true);

  store.ingest(sessionState({ status: "tool" }));
  flush();
  expect(button("Stop")).not.toBeNull();
  expect(button("Steer")).toBeNull();

  type(input, "actually");
  flush();
  expect(button("Steer")).not.toBeNull();
  expect(button("Stop")).toBeNull();

  type(input, "");
  const flow = uploads(store);
  fire(host.querySelector("textarea")!, "paste", {
    clipboardData: { files: [png("shot.png")] },
  });
  await until(() => flow.started.length === 1, "the upload to start");
  flow.settle("shot.png", {
    id: "a1",
    url: "/attachment/s1/shot.png",
    isImage: true,
  });
  await until(() => store.attachmentsOf("s1").length === 1, "the stored file");
  flush();
  expect(button("Steer")).not.toBeNull();
  expect(button("Stop")).toBeNull();

  button("Steer")!.click();
  flush();
  expect(said).toEqual(["hello", ""]);
  release();
});

test("the pills say spend and context fill, coloured by the ramp", () => {
  const store = offline();
  store.ingest(attached());
  store.ingest(sessionState());
  const { host } = paint(store);
  const fill = (): HTMLElement | undefined =>
    [...host.querySelectorAll("div")].find(
      (node) =>
        node.className.includes("px-2.5") &&
        node.textContent?.includes("%") === true
    );

  expect(host.textContent).not.toContain("$");
  expect(fill()).toBeUndefined();

  store.ingest(sessionState({ cost: 0.1234 }));
  flush();
  expect(host.textContent).toContain("$0.123");

  store.ingest(sessionState({ cost: 0.1234, contextPercent: 12.34 }));
  flush();
  expect(fill()?.textContent).toBe("12.3%");
  expect(fill()?.className).toContain("text-neutral-350");

  store.ingest(sessionState({ cost: 0, contextPercent: 40 }));
  flush();
  expect(host.textContent).not.toContain("$");
  expect(fill()?.className).toContain("text-neutral-350");

  store.ingest(sessionState({ cost: 0, contextPercent: 40.1 }));
  flush();
  expect(fill()?.className).toContain("text-amber-400");

  store.ingest(sessionState({ cost: 0, contextPercent: 69.9 }));
  flush();
  expect(fill()?.className).toContain("text-amber-400");

  store.ingest(sessionState({ cost: 0, contextPercent: 70 }));
  flush();
  expect(fill()?.className).toContain("text-rose-400");

  store.ingest(
    sessionState({ cost: 0, contextPercent: 70, contextWindow: 1_000_000 })
  );
  flush();
  expect(fill()?.textContent).toBe("70.0%/1.0M");
});

test("Enter sends where there is a keyboard and a modifier where there is not", async () => {
  const store = offline();
  answers(store, () => ({ thinkingLevels: ["off", "medium", "high"] }));
  const said: string[] = [];
  store.prompt = (async (text: string) => {
    said.push(text);
  }) as typeof store.prompt;
  store.ingest(attached());
  store.ingest(sessionState());
  const { input } = paint(store);

  expect(input.getAttribute("enterkeyhint")).toBe("send");
  type(input, "hello");
  expect(press(input, "Enter", { shiftKey: true }).defaultPrevented).toBe(
    false
  );
  flush();
  expect(input.value).toBe("hello");
  expect(said).toEqual([]);

  expect(press(input, "Enter").defaultPrevented).toBe(true);
  flush();
  expect(said).toEqual(["hello"]);
  expect(input.value).toBe("");

  const asked: string[] = [];
  store.client.send = (async (command: Command) => {
    if (command.type === "set_thinking") {
      asked.push(command.value as string);
    }
    return {
      type: "response",
      id: "1",
      success: true,
      models: [],
      thinkingLevels: ["off", "medium", "high"],
    };
  }) as typeof store.client.send;
  expect(press(input, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
  await until(() => asked.length === 1, "the level after medium");
  expect(asked).toEqual(["high"]);

  store.cancel = (async () => "what pi was holding") as typeof store.cancel;
  store.ingest(sessionState({ status: "tool" }));
  flush();
  type(input, "one more thing");
  expect(press(input, "Escape").defaultPrevented).toBe(true);
  await until(
    () => input.value.startsWith("what pi was holding"),
    "the queue to come back"
  );
  expect(input.value).toBe("what pi was holding\n\none more thing");
});

test("with no physical keyboard Enter is the newline and a modifier is the send", () => {
  softKeyboard();
  const store = offline();
  answers(store, () => ({}));
  const said: string[] = [];
  store.prompt = (async (text: string) => {
    said.push(text);
  }) as typeof store.prompt;
  store.ingest(attached());
  store.ingest(sessionState());
  const { input } = paint(store);

  expect(input.getAttribute("enterkeyhint")).toBe("enter");
  type(input, "hello");
  expect(press(input, "Enter").defaultPrevented).toBe(false);
  flush();
  expect(said).toEqual([]);
  expect(input.value).toBe("hello");

  press(input, "Enter", { ctrlKey: true });
  flush();
  expect(said).toEqual(["hello"]);

  type(input, "again");
  press(input, "Enter", { metaKey: true });
  flush();
  expect(said).toEqual(["hello", "again"]);
});

test("switching session swaps the box, the rows and the files", async () => {
  const store = offline();
  answers(store, () => rows("greeter.ts"));
  store.ingest(attached("s1"));
  const { host, input } = paint(store);
  const flow = uploads(store);

  type(input, "@gre");
  await until(() => options(host).length > 0, "the server's rows");
  press(input, "Escape");
  flush();
  expect(panel(host)).toBeUndefined();
  fire(input, "paste", { clipboardData: { files: [png("shot.png")] } });
  await until(() => flow.started.length === 1, "the upload to start");
  flush();
  expect(host.querySelectorAll("img")).toHaveLength(1);

  store.ingest(attached("s2"));
  flush();
  expect(input.value).toBe("");
  expect(options(host)).toHaveLength(0);
  expect(host.querySelectorAll("img")).toHaveLength(0);

  flow.settle("shot.png", {
    id: "a1",
    url: "/attachment/s1/shot.png",
    isImage: true,
  });
  await until(() => store.attachmentsOf("s1").length === 1, "the stored file");
  flush();
  expect(host.querySelectorAll("img")).toHaveLength(0);

  store.ingest(attached("s1"));
  flush();
  expect(input.value).toBe("@gre");
  expect(host.querySelectorAll("img")).toHaveLength(1);
  expect(options(host)).toHaveLength(0);
  expect(panel(host)?.textContent).toBe("no files");

  type(input, "@gret");
  await until(() => options(host).length > 0, "the rows for the next token");
});
