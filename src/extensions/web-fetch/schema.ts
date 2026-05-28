import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MIN_FETCH_BYTES = 1 * 1024;
export const DEFAULT_FETCH_BYTES = 32 * 1024;
export const MAX_FETCH_BYTES = 256 * 1024;

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
  maxBytes: Type.Optional(
    Type.Integer({
      minimum: MIN_FETCH_BYTES,
      maximum: MAX_FETCH_BYTES,
      description: `Max content bytes returned, ${MIN_FETCH_BYTES}-${MAX_FETCH_BYTES} (default: ${DEFAULT_FETCH_BYTES}).`,
    })
  ),
});

export type WebFetchInput = Static<typeof webFetchSchema>;
