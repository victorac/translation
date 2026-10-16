/**
 * A cautious token estimate. Latin text (English, digits, punctuation) is about four characters a token for the usual tokenizers,
 * counted here as three to stay on the safe side; any other character (Japanese, Chinese, an emoji) is counted as a token of its own.
 * It cannot guarantee any provider's tokenization.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let latin = 0;
  for (const c of text) {
    if (c.codePointAt(0)! < 0x300) latin++;
    else wide++;
  }
  return wide + Math.ceil(latin / 3);
}
