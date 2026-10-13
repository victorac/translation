import { classifyReply, type Asker } from "./extract.js";
import { condense, supported } from "./steps.js";
import { estimateTokens } from "./tokens.js";

/** A summary this short is just the scene descriptions put together. A model is only needed to make a long one shorter. */
export const SUMMARY_DIRECT_TOKENS = 220;

export interface BuiltSummary {
  text: string;
  /** Whether a model had to shorten anything. */
  usedModel: boolean;
  /** Shortened parts thrown away because the scenes do not support them, in favour of the scenes themselves. */
  unsupported: number;
  canceled: boolean;
}

/**
 * The summary of a document is its scene descriptions, in order. If that is short enough it is used as it is. If not,
 * a model shortens it in steps (groups of scenes, then the groups' summaries), and each shortened part is checked
 * against the scenes it came from: a part that adds anything is replaced by the scenes themselves.
 */
export async function buildSummary(input: {
  scenes: readonly string[];
  title: string;
  targetLanguage: string;
  asker: Asker;
  /** The most tokens of scene descriptions one request can carry. */
  room: number;
  shouldStop?: () => boolean;
}): Promise<BuiltSummary> {
  const latin = !/japan|chinese|korean|mandarin|cantonese/i.test(input.targetLanguage);
  let level = input.scenes.map((s) => s.trim()).filter(Boolean);
  let usedModel = false;
  let unsupported = 0;
  const small = (parts: readonly string[]) => estimateTokens(parts.join(" ")) <= SUMMARY_DIRECT_TOKENS;

  for (let pass = 0; pass < 3 && !small(level); pass++) {
    const groups: string[][] = [];
    let used = 0;
    for (const s of level) {
      const cost = estimateTokens(s) + 6;
      if (groups.length === 0 || used + cost > input.room) (groups.push([s]), (used = cost));
      else (groups.at(-1)!.push(s), (used += cost));
    }
    const parts: string[] = [];
    for (const g of groups) {
      if (input.shouldStop?.()) return { text: "", usedModel, unsupported, canceled: true };
      const original = g.join(" ");
      if (small(g)) {
        parts.push(original);
        continue;
      }
      const maxWords = Math.max(30, Math.min(120, Math.floor(estimateTokens(original) / 3)));
      const reply = await input.asker.ask(condense(input.title, g, maxWords, input.targetLanguage));
      if (reply === null) return { text: "", usedModel, unsupported, canceled: true };
      usedModel = true;
      const candidate = reply.trim().replace(/^(summary|answer)\s*[:：]\s*/i, "");
      const wrongLanguage = latin && /[぀-ヿ一-鿿]/.test(candidate);
      let ok = candidate !== "" && !wrongLanguage;
      if (ok) {
        const check = await input.asker.ask(supported(candidate, "this chapter", original));
        ok = check !== null && classifyReply(check, 2) === 0;
      }
      if (!ok) unsupported++;
      parts.push(ok ? candidate : original);
    }
    level = parts;
    if (groups.length === 1) break;
  }
  return { text: level.join(" ").trim(), usedModel, unsupported, canceled: false };
}
