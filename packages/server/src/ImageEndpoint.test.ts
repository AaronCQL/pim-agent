import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { IMMUTABLE } from "./StaticClient";
import { ImageEndpoint } from "./ImageEndpoint";

const SHA256 = "a".repeat(64);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let root: string;
let endpoint: ImageEndpoint;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pim-image-test-"));
  endpoint = new ImageEndpoint({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return endpoint.handle(new Request(`http://gateway${path}`));
}

test("owns only its own prefix", () => {
  expect(ImageEndpoint.owns("/image/x.png")).toBe(true);
  expect(ImageEndpoint.owns("/attachment/s1/x.png")).toBe(false);
});

test("serves the cached copy immutably", async () => {
  await Bun.write(join(root, `img-${SHA256}.png`), PNG);

  const response = await get(`/image/${SHA256}.png`);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe(IMMUTABLE);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array(PNG)
  );
});

test("404s once the TTL sweep has taken the file", async () => {
  expect((await get(`/image/${SHA256}.png`)).status).toBe(404);
});

test.each([
  ["a traversal", "/image/../../etc/passwd"],
  ["an encoded traversal", "/image/%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
  ["a name that is not content-addressed", "/image/session.jsonl"],
  ["an extension we never write", `/image/${SHA256}.svg`],
  ["a short digest", "/image/abc.png"],
  ["a nested path", `/image/sub/${SHA256}.png`],
])("rejects %s", async (_name, path) => {
  await Bun.write(join(root, "passwd"), "root:x:0:0");

  const response = await get(path);

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("not found");
});

test("refuses a method that is not a read", async () => {
  const response = await endpoint.handle(
    new Request(`http://gateway/image/${SHA256}.png`, { method: "DELETE" })
  );

  expect(response.status).toBe(405);
});
