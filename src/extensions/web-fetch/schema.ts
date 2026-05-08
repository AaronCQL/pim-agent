import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "typebox";

export const MIN_FETCH_BYTES = 1 * 1024;
export const DEFAULT_FETCH_BYTES = 32 * 1024;
export const MAX_FETCH_BYTES = 256 * 1024;

export const FETCH_FORMATS = ["auto", "markdown", "html"] as const;
export type WebFetchFormat = (typeof FETCH_FORMATS)[number];
export type WebFetchResolvedFormat = Exclude<WebFetchFormat, "auto">;

export const webFetchSchema = Type.Object({
  url: Type.String({
    minLength: 1,
    description:
      "URL to fetch. Must be a public http(s) URL; localhost and private IPs are rejected.",
  }),
  format: Type.Optional(
    StringEnum(FETCH_FORMATS, {
      description:
        "`auto` (default): markdown output with fallback to HTML. `markdown`: markdown only, fails if not available. `html`: HTML only.",
    })
  ),
  maxBytes: Type.Optional(
    Type.Integer({
      minimum: MIN_FETCH_BYTES,
      maximum: MAX_FETCH_BYTES,
      description: `Max content bytes returned, ${MIN_FETCH_BYTES}-${MAX_FETCH_BYTES}. Defaults to ${DEFAULT_FETCH_BYTES}.`,
    })
  ),
});

export type WebFetchInput = Static<typeof webFetchSchema>;
