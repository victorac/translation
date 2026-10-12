/**
 * MVP fallback token estimate (spec 04): one token per Unicode scalar.
 * Deliberately cautious; it cannot guarantee any provider's tokenization.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
