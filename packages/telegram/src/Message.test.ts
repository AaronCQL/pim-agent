import type { Context, Filter } from "grammy";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Message } from "./Message";
import type { SessionId } from "./Session";

const TOKEN = "test-token";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let configDir: string;
let requestedUrls: string[] = [];
const realFetch = globalThis.fetch;
const sessionId = { chatId: 4242 } as unknown as SessionId;

/** Enough of grammy's context for `toPrompt`, with a stubbed file host. */
function context(
  message: Record<string, unknown>,
  filePath = "photos/file_7.jpg"
): Filter<Context, "message"> {
  return {
    me: { id: 1 },
    message,
    api: { getFile: async () => ({ file_path: filePath }) },
  } as unknown as Filter<Context, "message">;
}

function attachmentDir(): string {
  return join(configDir, "attachments", "4242");
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "pim-telegram-message-"));
  requestedUrls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(PNG);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(configDir, { recursive: true, force: true });
});

test("plain text becomes the prompt verbatim", async () => {
  const prompt = await Message.toPrompt(
    context({ text: "hello there" }),
    TOKEN,
    configDir,
    sessionId
  );

  expect(prompt).toEqual({ text: "hello there", options: {} });
});

test("a reply quotes the earlier message above the body", async () => {
  const prompt = await Message.toPrompt(
    context({
      text: "and this?",
      reply_to_message: { from: { id: 1 }, text: "earlier" },
    }),
    TOKEN,
    configDir,
    sessionId
  );

  expect(prompt?.text).toBe(
    "Replying to your earlier message:\n> earlier\n\nand this?"
  );
});

test("an empty message produces no prompt at all", async () => {
  expect(
    await Message.toPrompt(context({ text: "" }), TOKEN, configDir, sessionId)
  ).toBeUndefined();
});

test("a photo is stored under the chat and inlined as an image", async () => {
  const prompt = await Message.toPrompt(
    context({
      caption: "look",
      photo: [{ file_id: "AgAD", file_unique_id: "AQADuniq" }],
    }),
    TOKEN,
    configDir,
    sessionId
  );

  const stored = await readdir(attachmentDir());
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatch(/^AQADuniq-\d+\.jpg$/);

  const path = join(attachmentDir(), stored[0]!);
  expect(prompt?.text).toBe(`look\n\n[Image attachment: ${path}]`);
  expect(prompt?.options.images).toEqual([
    { type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" },
  ]);
  expect(requestedUrls).toEqual([
    `https://api.telegram.org/file/bot${TOKEN}/photos/file_7.jpg`,
  ]);
});

test("a document is referenced by path and never inlined", async () => {
  const prompt = await Message.toPrompt(
    context(
      {
        document: {
          file_id: "BgAD",
          file_unique_id: "BQADuniq",
          file_name: "report.pdf",
          mime_type: "application/pdf",
        },
      },
      "documents/file_9.pdf"
    ),
    TOKEN,
    configDir,
    sessionId
  );

  const stored = await readdir(attachmentDir());
  expect(stored[0]).toMatch(/^BQADuniq-\d+\.pdf$/);
  expect(prompt?.text).toBe(
    `[Attachment: ${join(attachmentDir(), stored[0]!)}]`
  );
  expect(prompt?.options).toEqual({});
});
