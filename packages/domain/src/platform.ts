import { createHash, randomUUID } from "node:crypto";

/** The only Node-specific code in `domain`; everything else takes these as injectable deps. */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const newId = (): string => randomUUID();
