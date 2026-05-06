import * as Diff from "diff";

export type ToolDiffLineKind = "context" | "added" | "removed";

export type IntraLineRange = {
  readonly start: number;
  readonly end: number;
};

export type ToolDiffLine = {
  readonly kind: ToolDiffLineKind;
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
  readonly emphasis?: readonly IntraLineRange[];
};

export type ToolDiffHunk = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly ToolDiffLine[];
};

export type ToolDiff = {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
};

export class DiffLines {
  public static buildToolDiff(
    path: string,
    oldLines: readonly string[],
    newLines: readonly string[],
    contextSize: number
  ): ToolDiff | undefined {
    const lines = DiffLines.build(
      DiffLines.effectiveLines(oldLines),
      DiffLines.effectiveLines(newLines)
    );

    if (!lines.some((line) => line.kind !== "context")) {
      return undefined;
    }

    const emphasized = DiffLines.attachEmphasis(lines);

    return {
      path,
      hunks: DiffLines.buildHunks(emphasized, contextSize),
    };
  }

  private static attachEmphasis(
    lines: readonly ToolDiffLine[]
  ): readonly ToolDiffLine[] {
    const result: ToolDiffLine[] = [...lines];
    let i = 0;

    while (i < result.length) {
      if (result[i]?.kind !== "removed") {
        i += 1;
        continue;
      }

      let removedEnd = i;
      while (
        removedEnd < result.length &&
        result[removedEnd]?.kind === "removed"
      ) {
        removedEnd += 1;
      }

      let addedEnd = removedEnd;
      while (addedEnd < result.length && result[addedEnd]?.kind === "added") {
        addedEnd += 1;
      }

      const removedCount = removedEnd - i;
      const addedCount = addedEnd - removedEnd;

      if (removedCount > 0 && removedCount === addedCount) {
        for (let k = 0; k < removedCount; k += 1) {
          const removed = result[i + k];
          const added = result[removedEnd + k];

          if (removed === undefined || added === undefined) {
            continue;
          }

          const ranges = DiffLines.computeIntraLineRanges(
            removed.text,
            added.text
          );

          if (ranges === undefined) {
            continue;
          }

          result[i + k] = { ...removed, emphasis: ranges.removed };
          result[removedEnd + k] = { ...added, emphasis: ranges.added };
        }
      }

      i = addedEnd > i ? addedEnd : i + 1;
    }

    return result;
  }

  private static computeIntraLineRanges(
    oldText: string,
    newText: string
  ):
    | {
        readonly removed: readonly IntraLineRange[];
        readonly added: readonly IntraLineRange[];
      }
    | undefined {
    const parts = Diff.diffWords(oldText, newText);
    const removedRanges: IntraLineRange[] = [];
    const addedRanges: IntraLineRange[] = [];
    let oldPos = 0;
    let newPos = 0;
    let sharedLen = 0;
    let firstRemoved = true;
    let firstAdded = true;

    for (const part of parts) {
      const len = part.value.length;

      if (part.added === true) {
        const leading = firstAdded ? DiffLines.leadingWsLen(part.value) : 0;
        firstAdded = false;
        if (len - leading > 0) {
          addedRanges.push({ start: newPos + leading, end: newPos + len });
        }
        newPos += len;
        continue;
      }

      if (part.removed === true) {
        const leading = firstRemoved ? DiffLines.leadingWsLen(part.value) : 0;
        firstRemoved = false;
        if (len - leading > 0) {
          removedRanges.push({ start: oldPos + leading, end: oldPos + len });
        }
        oldPos += len;
        continue;
      }

      sharedLen += len;
      oldPos += len;
      newPos += len;
    }

    if (sharedLen === 0) {
      return undefined;
    }

    return { removed: removedRanges, added: addedRanges };
  }

  private static build(
    oldLines: readonly string[],
    newLines: readonly string[]
  ): readonly ToolDiffLine[] {
    const parts = Diff.diffLines(
      DiffLines.joinComparable(oldLines),
      DiffLines.joinComparable(newLines)
    );
    const lines: ToolDiffLine[] = [];
    let oldLine = 1;
    let newLine = 1;

    for (const part of parts) {
      const values = DiffLines.partLines(part.value);

      for (const text of values) {
        if (part.added === true) {
          lines.push({ kind: "added", newLine, text });
          newLine += 1;
          continue;
        }

        if (part.removed === true) {
          lines.push({ kind: "removed", oldLine, text });
          oldLine += 1;
          continue;
        }

        lines.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    }

    return lines;
  }

  private static effectiveLines(lines: readonly string[]): readonly string[] {
    if (lines.at(-1) === "") {
      return lines.slice(0, -1);
    }

    return lines;
  }

  public static splitLines(text: string): readonly string[] {
    return text.split("\n");
  }

  private static buildHunks(
    lines: readonly ToolDiffLine[],
    contextSize: number
  ): readonly ToolDiffHunk[] {
    const changeIndexes = lines
      .map((line, index) => (line.kind === "context" ? -1 : index))
      .filter((index) => index >= 0);
    const hunks: ToolDiffHunk[] = [];
    let firstChange = changeIndexes[0];
    let lastChange = changeIndexes[0];

    if (firstChange === undefined || lastChange === undefined) {
      return hunks;
    }

    const pushHunk = (startChange: number, endChange: number): void => {
      const hunkLines = lines.slice(
        Math.max(0, startChange - contextSize),
        Math.min(lines.length, endChange + contextSize + 1)
      );
      const oldNumbers = hunkLines.flatMap((line) =>
        line.oldLine === undefined ? [] : [line.oldLine]
      );
      const newNumbers = hunkLines.flatMap((line) =>
        line.newLine === undefined ? [] : [line.newLine]
      );
      const oldStart =
        oldNumbers.length === 0
          ? Math.max(0, (newNumbers[0] ?? 1) - 1)
          : Math.min(...oldNumbers);
      const newStart =
        newNumbers.length === 0
          ? Math.max(0, (oldNumbers[0] ?? 1) - 1)
          : Math.min(...newNumbers);

      hunks.push({
        oldStart,
        oldLines:
          oldNumbers.length === 0 ? 0 : Math.max(...oldNumbers) - oldStart + 1,
        newStart,
        newLines:
          newNumbers.length === 0 ? 0 : Math.max(...newNumbers) - newStart + 1,
        lines: hunkLines,
      });
    };

    for (const changeIndex of changeIndexes.slice(1)) {
      if (changeIndex - lastChange <= contextSize * 2 + 1) {
        lastChange = changeIndex;
        continue;
      }

      pushHunk(firstChange, lastChange);
      firstChange = changeIndex;
      lastChange = changeIndex;
    }

    pushHunk(firstChange, lastChange);

    return hunks;
  }

  private static leadingWsLen(value: string): number {
    return value.match(/^\s*/)?.[0].length ?? 0;
  }

  private static joinComparable(lines: readonly string[]): string {
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  private static partLines(value: string): readonly string[] {
    const lines = value.split("\n");

    if (lines.at(-1) === "") {
      lines.pop();
    }

    return lines;
  }
}
