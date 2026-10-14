import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The window imports `pure.ts`; anything it reaches that needs Node stops the window from loading at all. */
describe("pure.ts", () => {
  it("reaches no module that needs Node", () => {
    const seen = new Set<string>();
    const problems: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm)) {
        const spec = m[1]!;
        if (spec.startsWith("node:") || spec === "./platform.js") problems.push(`${file.split("/src/")[1]} imports ${spec}`);
        else if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    };
    visit(resolve(__dirname, "pure.ts"));
    expect(problems).toEqual([]);
  });
});
