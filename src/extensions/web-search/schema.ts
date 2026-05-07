import { type Static, Type } from "typebox";

export const MIN_NUM_RESULTS = 1;
export const MAX_NUM_RESULTS = 10;
export const DEFAULT_NUM_RESULTS = 5;

export const webSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Public web search query.",
  }),
  numResults: Type.Optional(
    Type.Integer({
      minimum: MIN_NUM_RESULTS,
      maximum: MAX_NUM_RESULTS,
      description: `Number of results, ${MIN_NUM_RESULTS}-${MAX_NUM_RESULTS}. Defaults to ${DEFAULT_NUM_RESULTS}.`,
    })
  ),
});

export type WebSearchInput = Static<typeof webSearchSchema>;
