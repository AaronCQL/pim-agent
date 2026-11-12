import type { ToolDiffHunk } from "#core/shared/DiffLines";

/** Lines per highlighted block; the highlighter gives up on longer ones. */
const CHUNK = 1000;

export class FileChunks {
  private readonly lines: readonly string[];
  private readonly hunks: ToolDiffHunk[];

  public constructor(lines: readonly string[]) {
    this.lines = lines;
    this.hunks = [];
  }

  public take(count: number): readonly ToolDiffHunk[] {
    while (
      this.hunks.length < count &&
      this.hunks.length * CHUNK < this.lines.length
    ) {
      const start = this.hunks.length * CHUNK;
      const slice = this.lines.slice(start, start + CHUNK);
      this.hunks.push({
        oldStart: start + 1,
        oldLines: slice.length,
        newStart: start + 1,
        newLines: slice.length,
        lines: slice.map((text, at) => ({
          kind: "context",
          oldLine: start + at + 1,
          newLine: start + at + 1,
          text,
        })),
      });
    }
    return this.hunks.slice(0, count);
  }
}
