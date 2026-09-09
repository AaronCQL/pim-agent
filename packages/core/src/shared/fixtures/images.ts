import { deflateSync } from "node:zlib";
import type { NormalisedImage } from "../Images";

export const PNG_MAGIC = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * A real downscale spins pi's Photon worker, which compiles its WASM on first
 * use — seconds on a cold CI runner, and `bun test` runs files in parallel
 * processes, so every suite that resizes pays it again. Bun's 5s default is
 * not enough; only tests that actually resize need this.
 */
export const RESIZE_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

function joined(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(encoder.encode(type), 4);
  out.set(body, 8);
  view.setUint32(
    out.length - 4,
    Bun.hash.crc32(out.subarray(4, out.length - 4))
  );
  return out;
}

/** A real, decodable RGB PNG: photon has to be able to open what the tests hand it. */
export function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * stride + 1 + x * 3;
      raw[pixel] = (x * 7 + y * 3) % 256;
      raw[pixel + 1] = (x * 13) % 256;
      raw[pixel + 2] = (y * 29) % 256;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;

  return joined(
    PNG_MAGIC,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0))
  );
}

function riffChunk(tag: string, bodyLength: number): Uint8Array {
  const out = new Uint8Array(8 + bodyLength + (bodyLength % 2));
  out.set(encoder.encode(tag), 0);
  new DataView(out.buffer).setUint32(4, bodyLength, true);
  return out;
}

function webpOf(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = joined(...chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(encoder.encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(encoder.encode("WEBP"), 8);
  out.set(body, 12);
  return out;
}

export function animatedWebp(
  count: number,
  bodyLength = 20
): Uint8Array<ArrayBuffer> {
  return webpOf([
    riffChunk("VP8X", 10),
    riffChunk("ANIM", 6),
    ...Array.from({ length: count }, () => riffChunk("ANMF", bodyLength)),
  ]);
}

/** 1x1 frames, which is all a frame count is read off. */
export function animatedGif(count: number): Uint8Array<ArrayBuffer> {
  return joined(
    encoder.encode("GIF89a"),
    Uint8Array.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    new Uint8Array(6),
    ...Array.from({ length: count }, () =>
      Uint8Array.from([
        0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      ])
    ),
    Uint8Array.from([0x3b])
  );
}

export function apng(count: number): Uint8Array<ArrayBuffer> {
  const control = new Uint8Array(8);
  new DataView(control.buffer).setUint32(0, count);
  return joined(
    PNG_MAGIC,
    chunk("IHDR", new Uint8Array(13)),
    chunk("acTL", control),
    chunk("IDAT", new Uint8Array(8))
  );
}

export function normalised(fields: Partial<NormalisedImage>): NormalisedImage {
  return {
    base64: "",
    mimeType: "image/webp",
    width: 1200,
    height: 800,
    bytes: 0,
    originalWidth: 1200,
    originalHeight: 800,
    originalMimeType: "image/webp",
    resized: false,
    frames: 1,
    sha256: "",
    cachePath: null,
    ...fields,
  };
}
