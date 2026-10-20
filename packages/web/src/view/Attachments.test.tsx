import "../test/dom";

import { render } from "@solidjs/web";
import { afterAll, expect, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import { mountPoint } from "../test/dom";
import { Attachments, type AttachmentTile } from "./Attachments";

const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname.includes("swept")
      ? new Response("not found", { status: 404 })
      : new Response("bytes"),
});

afterAll(async () => {
  await server.stop(true);
});

function tile(name: string): AttachmentTile {
  const url = `http://127.0.0.1:${server.port}/attachment/s1/${name}`;
  return { key: url, name, url, isImage: false };
}

test("a swept file shows as expired, a stored one stays a download", async () => {
  const realFetch = globalThis.fetch;
  const probes: Promise<Response>[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(((
    ...args: Parameters<typeof fetch>
  ) => {
    const probe = realFetch(...args);
    probes.push(probe);
    return probe;
  }) as typeof fetch);

  try {
    const host = mountPoint();
    render(
      () => (
        <Attachments
          variant="delivery"
          files={[tile("report.pdf"), tile("swept.pdf")]}
        />
      ),
      host
    );
    flush();
    expect(probes).toHaveLength(2);
    await Promise.all(probes);
    flush();

    const links = [...host.querySelectorAll("a[download]")];
    expect(links.map((link) => link.getAttribute("download"))).toEqual([
      "report.pdf",
    ]);
    expect(host.textContent).toContain("swept.pdfexpired");
  } finally {
    spy.mockRestore();
  }
});

test("a tile still uploading is never probed", () => {
  const spy = spyOn(globalThis, "fetch");
  try {
    render(
      () => <Attachments files={[{ ...tile("draft.pdf"), uploading: true }]} />,
      mountPoint()
    );
    flush();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
