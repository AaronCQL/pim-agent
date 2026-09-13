import { until } from "#core/shared/fixtures/wait";
import { Highlight, type Token } from "../view/highlight";

/**
 * Grammars load on demand, so the first ask for a language is always plain
 * text and the answer arrives an `import()` later. Waiting that out is the
 * behaviour, not a workaround for it.
 */
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
