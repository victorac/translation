import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** Settings kept between runs of the app. No source text, no secrets. */
export interface Settings {
  version: 1;
  provider: {
    baseUrl: string;
    /** The one non-local host (host:port) the user approved, if any. */
    allowedRemoteHost: string | null;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  provider: { baseUrl: "http://localhost:1234/v1", allowedRemoteHost: null },
};

const settingsSchema = z.object({
  version: z.literal(1),
  provider: z.object({ baseUrl: z.string().max(2000), allowedRemoteHost: z.string().max(300).nullable() }),
});

export interface SettingsStore {
  load(): Settings;
  save(settings: Settings): void;
}

export class MemorySettingsStore implements SettingsStore {
  private value: Settings = structuredClone(DEFAULT_SETTINGS);
  load(): Settings {
    return structuredClone(this.value);
  }
  save(settings: Settings): void {
    this.value = structuredClone(settings);
  }
}

/** Writes to a temporary file in the same folder and renames it, so a crash never leaves half a file. */
export function writeFileAtomic(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export class FileSettingsStore implements SettingsStore {
  constructor(private readonly path: string) {}

  load(): Settings {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
    try {
      return settingsSchema.parse(JSON.parse(raw));
    } catch {
      // Unreadable settings are set aside, not deleted, and defaults are used.
      try {
        renameSync(this.path, `${this.path}.damaged`);
      } catch {
        /* ignore */
      }
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  save(settings: Settings): void {
    writeFileAtomic(this.path, JSON.stringify(settings, null, 2));
  }
}

/** Where API keys live. They are never written to project files, exports, logs or the window. */
export interface CredentialStore {
  has(ref: string): boolean;
  get(ref: string): string | undefined;
  set(ref: string, secret: string): void;
  delete(ref: string): void;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>();
  has(ref: string): boolean {
    return this.map.has(ref);
  }
  get(ref: string): string | undefined {
    return this.map.get(ref);
  }
  set(ref: string, secret: string): void {
    this.map.set(ref, secret);
  }
  delete(ref: string): void {
    this.map.delete(ref);
  }
}

/** The part of Electron's `safeStorage` this needs (it encrypts with a key held in the operating system's keychain). */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private cache: Record<string, string>;

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher,
  ) {
    this.cache = this.read();
  }

  private read(): Record<string, string> {
    try {
      const parsed = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed;
    } catch {
      return {};
    }
  }

  has(ref: string): boolean {
    return ref in this.cache;
  }

  get(ref: string): string | undefined {
    const enc = this.cache[ref];
    if (enc === undefined || !this.cipher.isAvailable()) return undefined;
    try {
      return this.cipher.decrypt(Buffer.from(enc, "base64"));
    } catch {
      return undefined;
    }
  }

  set(ref: string, secret: string): void {
    if (!this.cipher.isAvailable()) throw new Error("This computer's secure storage is not available, so the key cannot be saved safely.");
    this.cache[ref] = this.cipher.encrypt(secret).toString("base64");
    this.flush();
  }

  delete(ref: string): void {
    delete this.cache[ref];
    this.flush();
  }

  private flush(): void {
    writeFileAtomic(this.path, JSON.stringify(this.cache));
  }
}
