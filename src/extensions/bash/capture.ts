import {
  type CapturedStream,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

export function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export class StreamCapture {
  private chunks: Uint8Array[] = [];
  private totalBytesAccum = 0;

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

  get truncated(): boolean {
    return this.totalBytesAccum > STREAM_HEAD_BYTES + STREAM_TAIL_BYTES;
  }

  full(): Uint8Array {
    return concat(this.chunks, this.totalBytesAccum);
  }

  snapshot(): CapturedStream {
    if (this.totalBytesAccum === 0) {
      return { text: "", totalBytes: 0, truncated: false };
    }
    const dec = new TextDecoder();
    if (!this.truncated) {
      return {
        text: dec.decode(this.full()),
        totalBytes: this.totalBytesAccum,
        truncated: false,
      };
    }
    const all = this.full();
    const headText = dec.decode(all.subarray(0, STREAM_HEAD_BYTES));
    const tailText = dec.decode(
      all.subarray(all.byteLength - STREAM_TAIL_BYTES)
    );
    const middle = this.totalBytesAccum - STREAM_HEAD_BYTES - STREAM_TAIL_BYTES;
    return {
      text: `${headText}\n... ${middle} bytes truncated ...\n${tailText}`,
      totalBytes: this.totalBytesAccum,
      truncated: true,
    };
  }
}
