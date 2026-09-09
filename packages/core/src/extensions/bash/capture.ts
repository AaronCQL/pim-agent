import { Lines } from "../../shared/Lines";
import {
  type CapturedStream,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

export class StreamCapture {
  private chunks: Uint8Array[] = [];
  private totalBytesAccum = 0;
  private fullBytes: Uint8Array | null = null;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.totalBytesAccum += chunk.byteLength;
  }

  get totalBytes(): number {
    return this.totalBytesAccum;
  }

  /** The first `n` bytes, read across however many chunks the kernel split them into. */
  lead(n: number): Uint8Array {
    if (this.fullBytes) {
      return this.fullBytes.subarray(0, n);
    }
    const lead = new Uint8Array(Math.min(n, this.totalBytesAccum));
    let at = 0;
    for (const chunk of this.chunks) {
      if (at === lead.byteLength) {
        break;
      }
      const take = chunk.subarray(0, lead.byteLength - at);
      lead.set(take, at);
      at += take.byteLength;
    }
    return lead;
  }

  full(): Uint8Array {
    if (!this.fullBytes) {
      this.fullBytes = Buffer.concat(this.chunks, this.totalBytesAccum);
      this.chunks = [];
    }
    return this.fullBytes;
  }

  /** Opaque bytes are not text: a half-image is worthless, so they are neither cut nor decoded. */
  snapshot(opaque = false): CapturedStream {
    if (this.totalBytesAccum === 0 || opaque) {
      return {
        text: "",
        totalBytes: this.totalBytesAccum,
        truncated: false,
        path: null,
        nextStart: null,
      };
    }
    const dec = new TextDecoder();
    const all = this.full();
    if (this.totalBytesAccum <= STREAM_HEAD_BYTES + STREAM_TAIL_BYTES) {
      return {
        text: dec.decode(all),
        totalBytes: this.totalBytesAccum,
        truncated: false,
        path: null,
        nextStart: null,
      };
    }
    const headText = dec.decode(all.subarray(0, STREAM_HEAD_BYTES));
    const tailText = dec.decode(
      all.subarray(all.byteLength - STREAM_TAIL_BYTES)
    );
    const middle = this.totalBytesAccum - STREAM_HEAD_BYTES - STREAM_TAIL_BYTES;
    return {
      text: `${headText}\n... ${middle} bytes truncated ...\n${tailText}`,
      totalBytes: this.totalBytesAccum,
      truncated: true,
      path: null,
      nextStart: Lines.continuationLine(headText),
    };
  }
}
