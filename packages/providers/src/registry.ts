import type { TranslationProvider } from "./types.js";

/** Selects an adapter by `kind`. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, TranslationProvider>();

  register(provider: TranslationProvider): this {
    if (this.adapters.has(provider.kind)) throw new Error(`Provider kind already registered: ${provider.kind}`);
    this.adapters.set(provider.kind, provider);
    return this;
  }

  get(kind: string): TranslationProvider {
    const p = this.adapters.get(kind);
    if (!p) throw new Error(`No adapter registered for provider kind: ${kind}`);
    return p;
  }

  kinds(): string[] {
    return [...this.adapters.keys()];
  }
}
