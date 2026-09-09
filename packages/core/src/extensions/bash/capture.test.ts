import { describe, expect, test } from "bun:test";
import { PNG_MAGIC } from "../../shared/fixtures/images";
import { Images } from "../../shared/Images";
import { StreamCapture } from "./capture";
import { STREAM_HEAD_BYTES, STREAM_TAIL_BYTES } from "./schema";

const enc = new TextEncoder();
const u8 = (s: string) => enc.encode(s);

/** Header plus filler: the capture only ever looks at the leading bytes. */
function pngish(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes).fill(0x41);
  bytes.set(PNG_MAGIC);
  return bytes;
}

describe("StreamCapture", () => {
  test("empty capture", () => {
    const c = new StreamCapture();
    expect(c.snapshot()).toEqual({
      text: "",
      totalBytes: 0,
      truncated: false,
      path: null,
      nextStart: null,
    });
  });

  test("ignores zero-byte chunks", () => {
    const c = new StreamCapture();
    c.push(new Uint8Array(0));
    c.push(u8("hi"));
    expect(c.snapshot()).toEqual({
      text: "hi",
      totalBytes: 2,
      truncated: false,
      path: null,
      nextStart: null,
    });
  });

  test("does not truncate when within head+tail budget", () => {
    const c = new StreamCapture();
    c.push(u8("hello"));
    c.push(u8(" world"));
    expect(c.snapshot()).toEqual({
      text: "hello world",
      totalBytes: 11,
      truncated: false,
      path: null,
      nextStart: null,
    });
  });

  test("truncates middle when over budget", () => {
    const c = new StreamCapture();
    const headChunk = "A".repeat(STREAM_HEAD_BYTES);
    const middleChunk = "X".repeat(1000);
    const tailChunk = "B".repeat(STREAM_TAIL_BYTES);
    c.push(u8(headChunk));
    c.push(u8(middleChunk));
    c.push(u8(tailChunk));

    const snap = c.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.totalBytes).toBe(STREAM_HEAD_BYTES + 1000 + STREAM_TAIL_BYTES);
    expect(snap.text.startsWith(headChunk)).toBe(true);
    expect(snap.text.endsWith(tailChunk)).toBe(true);
    expect(snap.text).toContain(`... ${1000} bytes truncated ...`);
    expect(snap.nextStart).toBe(1);
  });

  test("reports the resume line at the end of the head when truncated", () => {
    const c = new StreamCapture();
    const lineBytes = STREAM_HEAD_BYTES / 4;
    const headChunk = `${"A".repeat(lineBytes - 1)}\n`.repeat(4);
    c.push(u8(headChunk));
    c.push(u8("X".repeat(1000)));
    c.push(u8("B".repeat(STREAM_TAIL_BYTES)));

    const snap = c.snapshot();
    expect(snap.truncated).toBe(true);
    // Head holds exactly 4 newline-terminated lines, so reading resumes at 5.
    expect(snap.nextStart).toBe(5);
  });

  test("splits a single chunk between head and tail when needed", () => {
    const c = new StreamCapture();
    const big = "Z".repeat(STREAM_HEAD_BYTES + STREAM_TAIL_BYTES + 500);
    c.push(u8(big));

    const snap = c.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.totalBytes).toBe(big.length);
    expect(snap.text.startsWith("Z".repeat(STREAM_HEAD_BYTES))).toBe(true);
    expect(snap.text.endsWith("Z".repeat(STREAM_TAIL_BYTES))).toBe(true);
    expect(snap.text).toContain(`... ${500} bytes truncated ...`);
  });

  test("keeps head and final tail when many middle chunks arrive", () => {
    const c = new StreamCapture();
    const HEAD_FILL = "A".repeat(STREAM_HEAD_BYTES);
    c.push(u8(HEAD_FILL));
    for (let i = 0; i < 100; i++) {
      c.push(u8("M".repeat(STREAM_TAIL_BYTES)));
    }
    const finalTail = "B".repeat(STREAM_TAIL_BYTES);
    c.push(u8(finalTail));

    const snap = c.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.text.startsWith(HEAD_FILL)).toBe(true);
    expect(snap.text.endsWith(finalTail)).toBe(true);
  });

  test("at exact head+tail boundary is not truncated", () => {
    const c = new StreamCapture();
    c.push(u8("A".repeat(STREAM_HEAD_BYTES)));
    c.push(u8("B".repeat(STREAM_TAIL_BYTES)));
    const snap = c.snapshot();
    expect(snap.truncated).toBe(false);
    expect(snap.totalBytes).toBe(STREAM_HEAD_BYTES + STREAM_TAIL_BYTES);
  });
});

describe("StreamCapture opaque streams", () => {
  test("an over-budget picture is kept whole instead of truncated", () => {
    const c = new StreamCapture();
    const bytes = pngish(STREAM_HEAD_BYTES + STREAM_TAIL_BYTES + 500);
    c.push(bytes);

    const snap = c.snapshot(true);
    expect(snap.truncated).toBe(false);
    expect(snap.text).toBe("");
    expect(snap.totalBytes).toBe(bytes.byteLength);
    expect(c.full().byteLength).toBe(bytes.byteLength);
  });
});

describe("StreamCapture.lead", () => {
  test("reads a signature across chunk boundaries", () => {
    const c = new StreamCapture();
    const bytes = pngish(64);
    for (let at = 0; at < bytes.byteLength; at += 3) {
      c.push(bytes.subarray(at, at + 3));
    }
    expect(c.lead(Images.SNIFF_BYTES)).toEqual(
      bytes.subarray(0, Images.SNIFF_BYTES)
    );
  });

  test("stops at the bytes there are", () => {
    const c = new StreamCapture();
    c.push(PNG_MAGIC);
    expect(c.lead(Images.SNIFF_BYTES)).toEqual(PNG_MAGIC);
  });

  test("still reads once the chunks have been concatenated", () => {
    const c = new StreamCapture();
    c.push(pngish(64));
    c.full();
    expect(c.lead(4)).toEqual(PNG_MAGIC.subarray(0, 4));
  });
});
