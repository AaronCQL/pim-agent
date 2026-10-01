import { until } from "#core/shared/fixtures/wait";
import { Highlight, type Token } from "../view/highlight";

/** Waits for the lazily loaded grammar to produce highlighted tokens. */
export async function tokenized(
  code: string,
  lang: string
): Promise<readonly (readonly Token[])[]> {
  let lines: readonly (readonly Token[])[] = [];
  await until(() => {
    lines = Highlight.tokenize(code, lang);
    return lines.some((line) => line.some((token) => token.role !== undefined));
  }, `the ${lang} grammar`);
  return lines;
}
