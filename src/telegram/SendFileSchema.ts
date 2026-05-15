import { type Static, Type } from "typebox";

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 1024;

export const sendFileSchema = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "Absolute or relative path to file (resolved against cwd).",
  }),
  caption: Type.Optional(
    Type.String({
      description: `File caption in markdown. Max ${MAX_CAPTION_CHARS} chars.`,
      maxLength: MAX_CAPTION_CHARS,
    })
  ),
});

export type SendFileInput = Static<typeof sendFileSchema>;
