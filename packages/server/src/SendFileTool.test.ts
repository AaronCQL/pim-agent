import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentStore } from "#core/attachments/AttachmentStore";
import { SendFile } from "#core/shared/SendFile";
import { AttachmentEndpoint } from "./AttachmentEndpoint";
import { SendFileTool } from "./SendFileTool";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let tmp: string;
let cwd: string;
let root: string;

function tool(sessionId: () => string | undefined = () => "session-1") {
  return SendFileTool.build({
    store: new AttachmentStore(root),
    cwd,
    sessionId,
  });
}

function run(definition: ReturnType<typeof tool>, path: string) {
  return definition.execute(
    "call-1",
    { path },
    new AbortController().signal,
    undefined,
    {} as never
  );
}

function send(path: string, sessionId?: () => string | undefined) {
  return run(tool(sessionId), path);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-send-file-"));
  cwd = join(tmp, "work");
  root = join(tmp, "attachments");
  await mkdir(cwd, { recursive: true });
  await Bun.write(join(cwd, "revenue.png"), PNG);
  await Bun.write(join(cwd, "report.txt"), "quarterly\n");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("a sent image comes back as a name, a url and nothing else", async () => {
  const result = await send("revenue.png");

  expect(result.details).toEqual({
    name: "revenue.png",
    url: expect.stringMatching(
      /^\/attachment\/session-1\/revenue-\d+\.png$/
    ) as unknown as string,
    isImage: true,
  });

  // The model sees name and size, but never the URL.
  const said = JSON.stringify(result.content);
  expect(said).toContain("revenue.png");
  expect(said).toContain(String(PNG.byteLength));
  expect(said).not.toContain("/attachment/");
  expect(said).not.toContain(cwd);
});

test("a relative path is resolved against the session cwd", async () => {
  await mkdir(join(cwd, "out"), { recursive: true });
  await Bun.write(join(cwd, "out", "notes.md"), "# hi\n");

  const result = await send("out/notes.md");
  expect(result.details.name).toBe("notes.md");
  expect(result.details.isImage).toBe(false);
});

test("the bytes are fetchable at the url, and the agent's path is not", async () => {
  const result = await send("revenue.png");
  const endpoint = new AttachmentEndpoint({ root });

  const response = await endpoint.handle(
    new Request(`http://gateway${result.details.url}`)
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);

  expect(result.details.url).not.toContain(cwd);
  expect(JSON.stringify(result.details)).not.toContain(tmp);
});

test("only a regular file that exists and fits can be sent", async () => {
  expect(send("nope.png")).rejects.toThrow(/Path not found/);
  expect(send(".")).rejects.toThrow(/not a regular file/);

  const huge = join(cwd, "huge.bin");
  await Bun.write(huge, "");
  // Sparse file, so no real 50 MB write.
  await truncate(huge, SendFile.MAX_BYTES + 1);
  expect(send("huge.bin")).rejects.toThrow(/max allowed/);
});

test("a session pi has not named yet cannot send", async () => {
  expect(send("revenue.png", () => undefined)).rejects.toThrow(
    /cannot send files yet/
  );
});

test("the view carries the delivery, and only once there is one", async () => {
  const definition = tool();
  const args = { path: "revenue.png" };

  const pending = definition.toViewModel!({ args, isPartial: true, cwd });
  expect(pending.summary).toBeUndefined();
  expect(pending.title).toEqual([{ kind: "file", path: "revenue.png" }]);

  const result = await run(definition, args.path);
  const settled = definition.toViewModel!({
    args,
    // Only persisted details, as on replay.
    result: { content: [], details: result.details },
    isPartial: false,
    cwd,
  });
  expect(settled.summary).toEqual([
    {
      kind: "attachment",
      name: "revenue.png",
      url: result.details.url,
      isImage: true,
    },
  ]);
});
