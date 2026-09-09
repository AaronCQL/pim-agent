import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { usePimHome } from "./fixtures/home";
import {
  animatedGif,
  animatedWebp,
  apng,
  normalised,
  png,
} from "./fixtures/images";
import { Images } from "./Images";
import { SpillCache } from "./SpillCache";

usePimHome("pim-images-home-");

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const gif = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
]);
const html = new TextEncoder().encode(
  "<!DOCTYPE html>\n<html><body>404 Not Found</body></html>"
);
const zip = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
  Buffer.from("word/document.xml"),
]);
const json = new TextEncoder().encode('{"error":"not found","status":404}');
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const garbage = Uint8Array.from([
  0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x7f, 0x80, 0x00,
]);

describe("Images.sniff", () => {
  test.each([
    ["png", png(4, 4), "image/png"],
    ["jpeg", jpeg, "image/jpeg"],
    ["gif", gif, "image/gif"],
    ["webp", webp, "image/webp"],
  ] as const)("reads %s out of its magic bytes", (_name, bytes, mimeType) => {
    expect(Images.sniff(bytes)).toBe(mimeType);
  });

  test.each([
    ["an HTML error page", html],
    ["a ZIP archive", zip],
    ["JSON", json],
    ["a PDF", pdf],
    ["garbage", garbage],
    ["nothing", new Uint8Array(0)],
    ["a truncated PNG header", Uint8Array.from([0x89, 0x50, 0x4e])],
  ])("rejects %s", (_name, bytes) => {
    expect(Images.sniff(bytes)).toBeNull();
  });

  test("ignores a RIFF container that is not WebP", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from("WAVEfmt "),
    ]);
    expect(Images.sniff(wav)).toBeNull();
  });
});

describe("Images.isSupported", () => {
  test.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "accepts %s",
    (mimeType) => {
      expect(Images.isSupported(mimeType)).toBe(true);
    }
  );

  test.each(["image/svg+xml", "image/bmp", "application/pdf", "toString"])(
    "rejects %s",
    (mimeType) => {
      expect(Images.isSupported(mimeType)).toBe(false);
    }
  );
});

describe("Images.canSee", () => {
  test("reads the model's declared inputs", () => {
    expect(
      Images.canSee({ id: "anthropic/claude", input: ["text", "image"] })
    ).toBe(true);
    expect(Images.canSee({ id: "openai/o3-mini", input: ["text"] })).toBe(
      false
    );
  });

  test("assumes eyes when no model is bound", () => {
    expect(Images.canSee(undefined)).toBe(true);
  });
});

describe("Images.extensionOf", () => {
  test.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ] as const)("spells %s one way", (mimeType, extension) => {
    expect(Images.extensionOf(mimeType)).toBe(extension);
  });
});

describe("Images.looksLikeImageName", () => {
  test.each([
    "/tmp/shot.png",
    "/tmp/shot.JPG",
    "/tmp/shot.jpeg",
    "/tmp/shot.gif",
    "/tmp/shot.webp",
  ])("takes %s for a picture", (path) => {
    expect(Images.looksLikeImageName(path)).toBe(true);
  });

  test.each(["/tmp/notes.md", "/tmp/shot.png.txt", "/tmp/png", "/tmp/shot"])(
    "leaves %s to the text path",
    (path) => {
      expect(Images.looksLikeImageName(path)).toBe(false);
    }
  );
});

describe("Images.normalise", () => {
  test("shrinks an oversized image onto the long-edge cap", async () => {
    const image = await Images.normalise(png(3000, 1200), "/tmp/wide.png");

    expect(image.originalWidth).toBe(3000);
    expect(image.originalHeight).toBe(1200);
    expect(image.width).toBe(2000);
    expect(image.height).toBe(800);
    expect(image.resized).toBe(true);
    expect(image.bytes).toBe(Buffer.from(image.base64, "base64").byteLength);
    expect(Images.isSupported(image.mimeType)).toBe(true);
    expect(Images.noteOf(image)).toBe(
      "image resized from 3000x1200 to 2000x800; multiply coordinates by 1.50 to map to the original."
    );
  });

  test("passes a small image through untouched", async () => {
    const source = png(64, 48);
    const image = await Images.normalise(source, "/tmp/small.png");

    expect(image.mimeType).toBe("image/png");
    expect(image.width).toBe(64);
    expect(image.height).toBe(48);
    expect(image.resized).toBe(false);
    expect(image.base64).toBe(Buffer.from(source).toString("base64"));
    expect(image.frames).toBe(1);
    expect(Images.noteOf(image)).toBeUndefined();
  });

  test("writes the normalised bytes to a content-addressed path, idempotently", async () => {
    const source = png(48, 32);
    const first = await Images.normalise(source, "/tmp/cached.png");
    const second = await Images.normalise(source, "/tmp/copy-of-cached.png");

    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(first.cachePath).toBe(
      join(SpillCache.dir(), `img-${first.sha256}.png`)
    );
    expect(second.cachePath).toBe(first.cachePath);
    expect(basename(first.cachePath!)).toMatch(/^img-[0-9a-f]{64}\.png$/);

    const written = await Bun.file(first.cachePath!).bytes();
    expect(Bun.SHA256.hash(written, "hex")).toBe(first.sha256);
    expect(written.byteLength).toBe(first.bytes);
  });

  test("carries the source frame count onto the details a tool records", async () => {
    const image = await Images.normalise(animatedGif(3), "/tmp/spin.gif");

    expect(Images.detailsOf(image)).toEqual({
      sha256: image.sha256,
      mimeType: "image/gif",
      width: 1,
      height: 1,
      bytes: image.bytes,
      resized: false,
      frames: 3,
    });
  });

  test("refuses a file too large to decode", async () => {
    const huge = new Uint8Array(Images.MAX_SOURCE_BYTES + 1);
    huge.set(png(4, 4));

    await expect(Images.normalise(huge, "/tmp/huge.png")).rejects.toThrow(
      "Image is 25 MB, over the 25 MB read cap. Shrink it first: magick /tmp/huge.png -resize 2000x2000 /tmp/small.png"
    );
  });

  test.each([
    ["an HTML error page", html, "HTML document"],
    ["a ZIP archive", zip, "ZIP archive (.pptx/.docx/.xlsx are ZIPs)"],
    ["JSON", json, "JSON or text"],
    ["a PDF", pdf, "PDF document"],
    ["an empty download", new Uint8Array(0), "an empty file"],
    ["garbage", garbage, "unrecognized bytes (hex: 00 01 02 fe ff 00 7f 80)"],
  ])(
    "names %s when the bytes are not an image",
    async (_name, bytes, detected) => {
      await expect(Images.normalise(bytes, "/tmp/chart.png")).rejects.toThrow(
        `File has an image extension but its content is not a valid PNG/JPEG/GIF/WebP. Detected: ${detected}. This usually means a download saved an error page instead of the image. Use bash: file /tmp/chart.png`
      );
    }
  );

  test("reports a picture it cannot decode as one it cannot shrink", async () => {
    const truncated = png(32, 32).subarray(0, 40);

    await expect(
      Images.normalise(truncated, "/tmp/broken.png")
    ).rejects.toThrow(
      "Could not shrink /tmp/broken.png (40 bytes) under the 3.75 MB provider limit. Re-save it smaller: magick /tmp/broken.png -resize 2000x2000 -quality 80 /tmp/small.jpg"
    );
  });
});

describe("Images.contentOf", () => {
  test("puts the note ahead of the picture", async () => {
    const image = await Images.normalise(png(8, 8), "/tmp/note.png");

    expect(Images.contentOf(image, "look at this")).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", data: image.base64, mimeType: "image/png" },
    ]);
  });

  test("sends the picture alone when there is nothing to say", async () => {
    const image = await Images.normalise(png(8, 8), "/tmp/note.png");

    expect(Images.contentOf(image)).toEqual([
      { type: "image", data: image.base64, mimeType: "image/png" },
    ]);
  });
});

describe("Images.frames", () => {
  test.each([
    ["an animated webp", animatedWebp(346), "image/webp", 346],
    ["a still webp", webp, "image/webp", 1],
    ["an animated gif", animatedGif(3), "image/gif", 3],
    ["a still gif", animatedGif(1), "image/gif", 1],
    ["an apng", apng(12), "image/png", 12],
    ["a plain png", png(8, 8), "image/png", 1],
    ["a jpeg", jpeg, "image/jpeg", 1],
  ] as const)("counts %s", (_name, bytes, mimeType, expected) => {
    expect(Images.frames(bytes, mimeType)).toBe(expected);
  });

  test("steps over the pad byte an odd chunk body carries", () => {
    expect(Images.frames(animatedWebp(4, 21), "image/webp")).toBe(4);
  });

  test("stops at truncated bytes rather than looping", () => {
    expect(Images.frames(animatedWebp(3).subarray(0, 40), "image/webp")).toBe(
      1
    );
    expect(Images.frames(animatedGif(3).subarray(0, 30), "image/gif")).toBe(1);
  });
});

describe("Images.noteOf", () => {
  test("names the frames a still cannot show", () => {
    expect(Images.noteOf(normalised({ frames: 346 }))).toBe(
      "animated webp: 346 frames, 1200x800; frame 1 shown."
    );
  });

  test("reports the animation of a picture that was never resized", () => {
    expect(Images.noteOf(normalised({ frames: 3, resized: false }))).toBe(
      "animated webp: 3 frames, 1200x800; frame 1 shown."
    );
  });

  test("carries both notes when the animation was also downscaled", () => {
    expect(
      Images.noteOf(
        normalised({
          frames: 12,
          resized: true,
          width: 600,
          height: 400,
          mimeType: "image/gif",
          originalMimeType: "image/gif",
        })
      )
    ).toBe(
      "image resized from 1200x800 to 600x400; multiply coordinates by 2.00 to map to the original. " +
        "animated gif: 12 frames, 1200x800; frame 1 shown."
    );
  });

  test("takes the resize note off the one flag the dimensions set", () => {
    expect(
      Images.noteOf(normalised({ resized: false, width: 600 }))
    ).toBeUndefined();
    expect(
      Images.noteOf(normalised({ resized: true, width: 600, height: 400 }))
    ).toBe(
      "image resized from 1200x800 to 600x400; multiply coordinates by 2.00 to map to the original."
    );
  });

  test("names the source container, not the one the resize re-encoded to", () => {
    expect(
      Images.noteOf(normalised({ frames: 346, mimeType: "image/png" }))
    ).toBe("animated webp: 346 frames, 1200x800; frame 1 shown.");
  });
});
