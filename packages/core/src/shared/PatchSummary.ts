export type PatchOp = {
  readonly kind: "add" | "delete" | "update";
  readonly path: string;
  readonly movePath?: string;
};

const MOVE_TO_MARKER = "*** Move to:";
const FILE_MARKERS: ReadonlyArray<readonly [PatchOp["kind"], string]> = [
  ["add", "*** Add File: "],
  ["delete", "*** Delete File: "],
  ["update", "*** Update File: "],
];

type MutableOp = {
  readonly kind: PatchOp["kind"];
  readonly path: string;
  movePath?: string;
};

/**
 * Lightweight, fault-tolerant scan of V4A patch text into a per-file summary.
 * For renderers that need to label a patch without depending on the apply-patch
 * grammar parser; unrecognized lines are ignored rather than throwing.
 */
export class PatchSummary {
  public static fromText(input: string): readonly PatchOp[] {
    const ops: MutableOp[] = [];

    for (const raw of input.split("\n")) {
      const line = raw.trim();
      const op = PatchSummary.fileOp(line);
      if (op) {
        ops.push(op);
      } else if (line.startsWith(MOVE_TO_MARKER)) {
        const current = ops.at(-1);
        if (current?.kind === "update") {
          current.movePath = PatchSummary.clean(
            line.slice(MOVE_TO_MARKER.length)
          );
        }
      }
    }

    return ops;
  }

  // The first affected path, without building the full per-file summary — for
  // callers that only need a title (e.g. a tool-call header on the render path).
  public static firstPath(input: string): string | undefined {
    for (const raw of input.split("\n")) {
      const op = PatchSummary.fileOp(raw.trim());
      if (op) {
        return op.path;
      }
    }
    return undefined;
  }

  private static fileOp(line: string): MutableOp | undefined {
    for (const [kind, marker] of FILE_MARKERS) {
      if (line.startsWith(marker)) {
        return { kind, path: PatchSummary.clean(line.slice(marker.length)) };
      }
    }
    return undefined;
  }

  private static clean(raw: string): string {
    let path = raw.trim();
    if (path.startsWith("@")) {
      path = path.slice(1).trim();
    }
    if (path.length >= 2) {
      const first = path[0]!;
      const last = path.at(-1)!;
      if ((first === '"' || first === "'" || first === "`") && first === last) {
        path = path.slice(1, -1);
      }
    }
    return path;
  }
}
