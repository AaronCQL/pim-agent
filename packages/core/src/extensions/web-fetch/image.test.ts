import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { usePimHome } from "../../shared/fixtures/home";
import { png } from "../../shared/fixtures/images";
import { Images } from "../../shared/Images";
import { executeFetch, type WebFetchOutcome } from "./fetch";
import { fetchImage, imageContent, imageDetails, noVisionNote } from "./image";
import type { JinaReaderClient } from "./JinaReaderClient";
import type { WebViewFetchClient } from "./WebViewFetchClient";

usePimHome("pim-fetch-image-");

const MEGABYTE = new Uint8Array(1024 * 1024);
MEGABYTE.set(png(4, 4).subarray(0, 8));

/** Streams past the cap with no content-length. */
function endlessImage(): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(MEGABYTE);
        sent += MEGABYTE.byteLength;
        if (sent > Images.MAX_SOURCE_BYTES + MEGABYTE.byteLength) {
          controller.close();
        }
      },
    }),
    { headers: { "content-type": "image/png" } }
  );
}

const routes: Record<string, () => Response> = {
  "/chart.png": () =>
    new Response(png(1200, 800), { headers: { "content-type": "image/png" } }),
  "/small.png": () =>
    new Response(png(48, 32), { headers: { "content-type": "image/png" } }),
  "/liar.png": () =>
    new Response("<!DOCTYPE html>\n<html>404 not found</html>", {
      headers: { "content-type": "image/png" },
    }),
  "/endless.png": endlessImage,
  "/page.html": () =>
    new Response("<html><body>hello</body></html>", {
      headers: { "content-type": "text/html" },
    }),
};

let server: ReturnType<typeof Bun.serve>;

function url(path: string): string {
  return new URL(path, server.url).href;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const route = routes[new URL(request.url).pathname];
      return route === undefined
        ? new Response("nope", { status: 404 })
        : route();
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const unreachable = {
  fetchUrl: () => {
    throw new Error("The reader must not be consulted for an image.");
  },
  fetchMarkdown: () => {
    throw new Error("The web view must not be consulted for an image.");
  },
  fetchHtml: () => {
    throw new Error("The web view must not be consulted for an image.");
  },
};

function fetchPage(path: string, format: "markdown" | "html" = "markdown") {
  return executeFetch({
    jina: unreachable as unknown as JinaReaderClient,
    webView: unreachable as unknown as WebViewFetchClient,
    url: url(path),
    format,
  });
}

function image(outcome: WebFetchOutcome) {
  if (outcome.kind !== "image") {
    throw new Error(`expected an image outcome, got ${outcome.kind}`);
  }
  return outcome.image;
}

describe("fetchImage", () => {
  test("returns the picture a PNG URL serves, ahead of any reader", async () => {
    const outcome = await fetchPage("/chart.png");
    expect(image(outcome).width).toBe(1200);
    expect(image(outcome).height).toBe(800);
    expect(image(outcome).mimeType).toBe("image/png");
    expect(image(outcome).cachePath).toEndWith(
      `${Images.cacheName(image(outcome).sha256, "image/png")}`
    );
  });

  test("takes the image branch in HTML mode too, where format is meaningless", async () => {
    expect((await fetchPage("/chart.png", "html")).kind).toBe("image");
  });

  test("leaves an error page mislabelled as a PNG to the page path", async () => {
    expect(await fetchImage({ url: url("/liar.png") })).toBeNull();
  });

  test("ignores a response that never claimed to be an image", async () => {
    expect(await fetchImage({ url: url("/page.html") })).toBeNull();
  });

  test("refuses a declared length over the source cap before buffering", async () => {
    const declaredHuge = async () =>
      new Response(png(4, 4), {
        headers: {
          "content-type": "image/png",
          "content-length": `${Images.MAX_SOURCE_BYTES + 1}`,
        },
      });

    await expect(
      fetchImage({ url: url("/chart.png"), fetch: declaredHuge })
    ).rejects.toThrow(
      `Image at ${url("/chart.png")} is over the 25 MB fetch cap.`
    );
  });

  test("refuses an undeclared body once it streams past the cap", async () => {
    await expect(fetchImage({ url: url("/endless.png") })).rejects.toThrow(
      "is over the 25 MB fetch cap."
    );
  });

  test("falls back to the page path when the probe cannot connect", async () => {
    expect(
      await fetchImage({
        url: url("/chart.png"),
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      })
    ).toBeNull();
  });
});

describe("image result", () => {
  test("sends the picture with a footer naming the cache path", async () => {
    const picture = image(await fetchPage("/small.png"));
    const content = imageContent(picture);

    expect(content).toEqual([
      { type: "image", data: picture.base64, mimeType: "image/png" },
      {
        type: "text",
        text: `[web_fetch tool: image saved to ${picture.cachePath}]`,
      },
    ]);
  });

  test("tells a model without vision what it got instead of throwing", async () => {
    const picture = image(await fetchPage("/chart.png"));

    expect(noVisionNote(url("/chart.png"), picture)).toBe(
      `[web_fetch tool: ${url("/chart.png")} is a 1200x800 png, saved to ${picture.cachePath}; the current model has no vision input.]`
    );
  });

  test("addresses the cached picture by hash, never by bytes", async () => {
    const picture = image(await fetchPage("/small.png"));

    expect(imageDetails(url("/small.png"), picture, true)).toEqual({
      kind: "image",
      url: url("/small.png"),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mimeType: "image/png",
      width: 48,
      height: 32,
      bytes: expect.any(Number),
      resized: false,
      frames: 1,
      path: picture.cachePath,
      withheld: true,
    });
    expect(imageDetails(url("/small.png"), picture, false).withheld).toBe(
      false
    );
  });
});
