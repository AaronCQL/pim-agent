import { type Static, Type } from "typebox";
import type { ImageDetails } from "../../shared/Images";

export const readSchema = Type.Object({
  path: Type.String({
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
  start: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "First line to return, 1-indexed. Defaults to 1.",
    })
  ),
  end: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Last line to return, 1-indexed and inclusive. Defaults to EOF or the byte cap.",
    })
  ),
});

export type ReadInput = Static<typeof readSchema>;

export type ReadRange = {
  readonly start: number;
  readonly end?: number;
};

type ReadTextDetails = {
  readonly kind: "text";
  readonly absolutePath: string;
  readonly totalLines: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly truncatedByByteCap: boolean;
  readonly truncatedByEnd: boolean;
  readonly hadBom: boolean;
  readonly nextStart?: number;
};

export type ReadImageDetails = ImageDetails & {
  readonly kind: "image";
  readonly absolutePath: string;
  /** Only a note was sent; the image went out earlier. */
  readonly deduped?: boolean;
};

export type ReadDetails = ReadTextDetails | ReadImageDetails;
