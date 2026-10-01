import { MovePath } from "#core/view/MovePath";
import { elide } from "../format";

export type Role = "lead" | "name" | "gone";

export type Piece = { readonly text: string; readonly role: Role };

/** One rendering of a path, whole or shortened. */
export type Title = readonly Piece[];

function directory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function file(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Longest first: whole, then dropping leading segments, then empty. */
function leads(dir: string): readonly string[] {
  if (dir === "") {
    return [""];
  }
  const segments = dir.slice(0, -1).split("/");
  const dropped = segments.map((_, index) => {
    const rest = segments.slice(index + 1).join("/");
    return rest === "" ? "…/" : `…/${rest}/`;
  });
  return [dir, ...dropped, ""];
}

function named(path: string): readonly Title[] {
  const name = file(path);
  return leads(directory(path)).map((lead) =>
    lead === ""
      ? [{ text: name, role: "name" as const }]
      : [
          { text: lead, role: "lead" as const },
          { text: name, role: "name" as const },
        ]
  );
}

const ARROW: Piece = { text: ` ${MovePath.ARROW} `, role: "lead" };

/** `a/{Old ➝ New}.ts`; paths with nothing in common stay whole. */
function moved(path: string, oldPath: string): readonly Title[] {
  const folded = MovePath.fold(oldPath, path);
  if (folded === undefined) {
    return named(path).map((title) => [
      { text: oldPath, role: "gone" as const },
      ARROW,
      ...title,
    ]);
  }

  const tail: Title = [
    { text: "{", role: "lead" },
    { text: folded.from, role: "gone" },
    ARROW,
    { text: folded.to, role: "name" },
    { text: "}", role: "lead" },
    ...(folded.suffix === ""
      ? []
      : [
          { text: directory(folded.suffix), role: "lead" as const },
          { text: file(folded.suffix), role: "name" as const },
        ]),
  ];

  return leads(folded.prefix).map((lead) =>
    lead === "" ? tail : [{ text: lead, role: "lead" as const }, ...tail]
  );
}

/** Widest first; a move that no longer fits falls back to its new path. */
function readings(path: string, oldPath: string | undefined): readonly Title[] {
  const plain = named(path);
  return oldPath === undefined ? plain : [...moved(path, oldPath), ...plain];
}

function text(title: Title): string {
  return title.map((piece) => piece.text).join("");
}

function widest(readings: readonly Title[]): string {
  return text(readings[0] ?? []);
}

/** The widest reading that fits `columns`; failing that, the name elided middle-out. */
function fit(readings: readonly Title[], columns: number): Title {
  const found = readings.find((title) => text(title).length <= columns);
  if (found !== undefined) {
    return found;
  }
  const name = file(text(readings[readings.length - 1] ?? []));
  return [{ text: elide(name, columns), role: "name" }];
}

export const FileTitle = { readings, text, widest, fit };
