import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ImageDetails } from "../../shared/Images";

export const WEB_FETCH_INLINE_BYTES = 32 * 1024;

export const FETCH_FORMATS = ["markdown", "html"] as const;
export type WebFetchFormat = (typeof FETCH_FORMATS)[number];
export type WebFetchResolvedFormat = WebFetchFormat;

export const webFetchSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description: "Must be a public http(s) URL.",
  }),
  format: Type.Optional(
    StringEnum(FETCH_FORMATS, {
      description:
        "`markdown`: used by default. `html`: use only when raw source is required.",
    })
  ),
});

export type WebFetchInput = Static<typeof webFetchSchema>;

export type WebFetchPageDetails = {
  readonly kind: "page";
  readonly url: string;
  readonly title: string;
  readonly format: WebFetchResolvedFormat;
  readonly returnedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly path: string | null;
};

export type WebFetchImageDetails = ImageDetails & {
  readonly kind: "image";
  readonly url: string;
  /** `~/.pim/cache/img-<sha256>.<ext>`, or null when the cache write failed. */
  readonly path: string | null;
  /** Cached and shown here, but never sent: the current model has no vision input. */
  readonly withheld: boolean;
};

export type WebFetchDetails = WebFetchPageDetails | WebFetchImageDetails;
