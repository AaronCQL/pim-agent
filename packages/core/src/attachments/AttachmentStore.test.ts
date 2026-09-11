import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AttachmentStore } from "./AttachmentStore";
import { Attachments } from "./Attachments";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;

function bytes(source: Uint8Array | string): ArrayBuffer {
  const view =
    typeof source === "string" ? new TextEncoder().encode(source) : source;
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pim-attachments-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("an image is inlined and named by a server path", async () => {
  const stored = await new AttachmentStore(root).store("session-1", {
    bytes: bytes(PNG),
    mimeType: "image/png",
    name: "shot.png",
  });

  expect(stored.imageBase64).toBe(Buffer.from(PNG).toString("base64"));
  expect(stored.path).toStartWith(join(root, "session-1"));
  expect(stored.path).toEndWith(".png");
  expect(await Bun.file(stored.path).exists()).toBe(true);

  const prompt = Attachments.render([stored]);
  expect(prompt.lines).toEqual([`[Image attachment: ${stored.path}]`]);
  expect(prompt.images).toEqual([
    { type: "image", data: stored.imageBase64!, mimeType: "image/png" },
  ]);
});

test("a non-image is referenced by server path and never inlined", async () => {
  const stored = await new AttachmentStore(root).store("session-1", {
    bytes: bytes("log line\n"),
    mimeType: "text/plain",
    name: "app.log",
  });

  expect(stored.imageBase64).toBeUndefined();
  expect(await Bun.file(stored.path).text()).toBe("log line\n");

  const prompt = Attachments.render([stored]);
  expect(prompt.lines).toEqual([`[Attachment: ${stored.path}]`]);
  expect(prompt.images).toEqual([]);
});

test("a client path survives only as an extension", async () => {
  const stored = await new AttachmentStore(root).store("session-1", {
    bytes: bytes("x"),
    mimeType: "text/plain",
    name: "/home/someone-else/secrets/notes.txt",
  });

  expect(dirname(stored.path)).toBe(join(root, "session-1"));
  expect(stored.path).not.toContain("someone-else");
  expect(stored.path).not.toContain("notes");
  expect(stored.path).toEndWith(".txt");
});

test("traversal in the filename cannot escape the scope", async () => {
  const stored = await new AttachmentStore(root).store("session-1", {
    bytes: bytes("x"),
    mimeType: "text/plain",
    name: "../../../../etc/passwd",
  });

  expect(dirname(stored.path)).toBe(join(root, "session-1"));
});

test("traversal in the scope is refused outright", async () => {
  const store = new AttachmentStore(join(root, "attachments"));

  expect(
    store.store("..", { bytes: bytes("x"), mimeType: "text/plain" })
  ).rejects.toThrow(/refusing attachment path/);
});

test("an explicit stem and extension are kept verbatim", async () => {
  const stored = await new AttachmentStore(root).store("42", {
    bytes: bytes(PNG),
    mimeType: "image/jpeg",
    stem: "AgADAQADq6c",
    ext: ".jpg",
  });

  expect(stored.id).toMatch(/^AgADAQADq6c-\d+\.jpg$/);
});

/**
 * The other direction: a file already on the agent's disk, copied in so the
 * endpoint can answer for it. The copy is the point — the transcript that
 * references it outlives whatever the agent does to the original next.
 */
test("a file the agent nominated is copied under a stamped name", async () => {
  const source = join(root, "revenue.png");
  await Bun.write(source, PNG);

  const store = new AttachmentStore(join(root, "store"));
  const stored = await store.storeFile("session-1", source);

  expect(stored.id).toMatch(/^revenue-\d+\.png$/);
  expect(dirname(stored.path)).toBe(join(root, "store", "session-1"));
  expect(stored.mimeType).toStartWith("image/png");
  expect(await Bun.file(stored.path).bytes()).toEqual(PNG);

  // A copy, not a link: rewriting the original leaves the delivery alone.
  await Bun.write(source, "not a png anymore");
  expect(await Bun.file(stored.path).bytes()).toEqual(PNG);
});

test("a delivered file is scoped and named like any other", async () => {
  const source = join(root, "notes");
  await Bun.write(source, "x");
  const store = new AttachmentStore(join(root, "store"));

  const stored = await store.storeFile("session-1", source);
  expect(store.locate("session-1", stored.id)).toBe(stored.path);
  // No extension to borrow, and none invented.
  expect(stored.id).toMatch(/^notes-\d+$/);
  expect(stored.mimeType).toBe("application/octet-stream");

  expect(store.storeFile("..", source)).rejects.toThrow(
    /refusing attachment path/
  );
});
