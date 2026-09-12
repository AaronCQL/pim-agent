import { MovePath } from "#core/view/MovePath";
import { elide } from "../format";

/** What a piece of a title is, and so how far it may be spent for room. */
export type Role = "lead" | "name" | "gone";

export type Piece = { readonly text: string; readonly role: Role };

/** One reading of a path, whole or shortened; the pieces read left to right. */
export type Title = readonly Piece[];

function directory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function file(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The ways `dir` can lead to a name, longest first: whole, then a segment at a
 * time off the front, then gone. The near directories outlive the far ones —
 * `…/topbar/` says where the file is, `packages/web/` says only which repo.
 */
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

/** A path with only its last segment lit: the directories lead the eye to the name. */
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

/**
 * A moved file reads as one path with the changed segments braced —
 * `packages/web/src/diff/{DiffOverlay ➝ DiffView}.test.tsx` — the same way the
 * patch tool titles a move, down to the arrow and the strike through what is
 * gone. Two paths that share nothing to fold are left whole.
 */
function moved(path: string, oldPath: string): readonly Title[] {
  const folded = MovePath.fold(oldPath, path);
  if (folded === undefined) {
    return named(path).map((title) => [
      { text: oldPath, role: "gone" as const },
      ARROW,
      ...title,
    ]);
  }

  // The new segments stay lit even when they are directories: they are the move.
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

/**
 * Every reading of a file's title, widest first. A move that no longer fits is
 * read as the path it arrived at: the row's own `R` already says it moved, and
 * where it moved from is one tap away.
 */
function readings(path: string, oldPath: string | undefined): readonly Title[] {
  const plain = named(path);
  return oldPath === undefined ? plain : [...moved(path, oldPath), ...plain];
}

function text(title: Title): string {
  return title.map((piece) => piece.text).join("");
}

/** The whole of it, which is what a box is measured against. */
function widest(readings: readonly Title[]): string {
  return text(readings[0] ?? []);
}

/**
 * The widest reading `columns` character cells hold whole. Nothing holds a name
 * longer than the bar itself, so that one is elided middle-out — both ends of a
 * filename say more than its head alone.
 */
function fit(readings: readonly Title[], columns: number): Title {
  const found = readings.find((title) => text(title).length <= columns);
  if (found !== undefined) {
    return found;
  }
  const name = file(text(readings[readings.length - 1] ?? []));
  return [{ text: elide(name, columns), role: "name" }];
}

export const FileTitle = { readings, text, widest, fit };
