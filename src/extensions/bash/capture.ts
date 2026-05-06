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
  private head: Uint8Array[] = [];
  private headBytes = 0;
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private totalBytesAccum = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.totalBytesAccum += chunk.byteLength;

    if (this.headBytes < STREAM_HEAD_BYTES) {
      const need = STREAM_HEAD_BYTES - this.headBytes;
      if (chunk.byteLength <= need) {
        this.head.push(chunk);
        this.headBytes += chunk.byteLength;
        return;
      }
      this.head.push(chunk.subarray(0, need));
      this.headBytes += need;
      chunk = chunk.subarray(need);
    }

    this.tail.push(chunk);
    this.tailBytes += chunk.byteLength;

    while (this.tail.length > 0 && this.tailBytes > STREAM_TAIL_BYTES) {
      const first = this.tail[0]!;
      if (this.tailBytes - first.byteLength >= STREAM_TAIL_BYTES) {
        this.tail.shift();
        this.tailBytes -= first.byteLength;
      } else {
        const drop = this.tailBytes - STREAM_TAIL_BYTES;
        this.tail[0] = first.subarray(drop);
        this.tailBytes -= drop;
      }
    }
  }

  get totalBytes(): number {
    return this.totalBytesAccum;
  }

  snapshot(): CapturedStream {
    if (this.totalBytesAccum === 0) {
      return { text: "", totalBytes: 0, truncated: false };
    }
    const dec = new TextDecoder();
    const truncated = this.totalBytesAccum > this.headBytes + this.tailBytes;
    if (!truncated) {
      const all = concat(
        [...this.head, ...this.tail],
        this.headBytes + this.tailBytes
      );
      return {
        text: dec.decode(all),
        totalBytes: this.totalBytesAccum,
        truncated: false,
      };
    }
    const headText = dec.decode(concat(this.head, this.headBytes));
    const tailText = dec.decode(concat(this.tail, this.tailBytes));
    const middle = this.totalBytesAccum - this.headBytes - this.tailBytes;
    return {
      text: `${headText}\n... ${middle} bytes truncated ...\n${tailText}`,
      totalBytes: this.totalBytesAccum,
      truncated: true,
    };
  }
}
