import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { PiAuthStorageData, PiAuthStorageHost } from "../../src/local/agent/auth-storage.js";

const require = createRequire(import.meta.url);

export interface SecureSettingsStatus {
  encryptionAvailable: boolean;
  configuredProviders: string[];
  /**
   * Saved provider credentials could not be decrypted (for example after the
   * Safe Storage key was reset). They were set aside next to the settings file,
   * never deleted, and the person needs to re-enter their credentials.
   */
  credentialsNeedReentry?: boolean;
}

/** The slice of Electron's `safeStorage` this store uses; injectable for tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecureSettingsStoreOptions {
  safeStorage?: SafeStorageLike;
  now?: () => Date;
}

interface SecureSettingsFile {
  schemaVersion: 2;
  credentials: PiAuthStorageData;
}

const emptySettings = (): SecureSettingsFile => ({
  schemaVersion: 2,
  credentials: {},
});

/** Encrypted, application-scoped credentials. Never stored inside a Connected Folder. */
export class SecureSettingsStore implements PiAuthStorageHost {
  private queue: Promise<void> = Promise.resolve();
  private cache: SecureSettingsFile | undefined;
  private credentialsSetAside = false;
  private readonly safeStorage: SafeStorageLike;
  private readonly now: () => Date;

  constructor(private readonly filePath: string, options: SecureSettingsStoreOptions = {}) {
    this.safeStorage = options.safeStorage ?? (require("electron") as typeof import("electron")).safeStorage;
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<SecureSettingsStatus> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      return { encryptionAvailable: false, configuredProviders: [] };
    }
    const data = await this.read();
    return {
      encryptionAvailable: true,
      configuredProviders: Object.keys(data.credentials).sort(),
      ...(this.credentialsSetAside ? { credentialsNeedReentry: true } : {}),
    };
  }

  async load(): Promise<PiAuthStorageData | undefined> {
    const credentials = (await this.read()).credentials;
    return Object.keys(credentials).length ? credentials : undefined;
  }

  async save(credentials: PiAuthStorageData): Promise<void> {
    await this.update((data) => {
      data.credentials = { ...credentials };
    });
  }

  async getProviderApiKey(provider: string): Promise<string | undefined> {
    const credential = (await this.read()).credentials[normalizeProvider(provider)];
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
    const key = normalizeProvider(provider);
    const value = apiKey.trim();
    if (!value) throw new Error("API key cannot be empty.");
    await this.update((data) => {
      data.credentials[key] = { type: "api_key", key: value };
    });
  }

  async clearProviderApiKey(provider: string): Promise<void> {
    const key = normalizeProvider(provider);
    await this.update((data) => {
      delete data.credentials[key];
    });
  }

  private async update(mutator: (data: SecureSettingsFile) => void): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const data = await this.read();
      mutator(data);
      await this.write(data);
    });
    this.queue = operation;
    await operation;
  }

  private async read(): Promise<SecureSettingsFile> {
    if (this.cache) return structuredClone(this.cache);
    if (!existsSync(this.filePath) && !existsSync(this.backupPath())) {
      this.cache = emptySettings();
      return structuredClone(this.cache);
    }
    // Unavailable secure storage (for example a denied Keychain prompt) is
    // transient: throw without caching so a later read can try again.
    this.assertEncryptionAvailable();
    let firstError: unknown;
    for (const candidate of [this.filePath, this.backupPath()]) {
      if (!existsSync(candidate)) continue;
      try {
        const decrypted = this.safeStorage.decryptString(await readFile(candidate));
        this.cache = normalizeSettings(JSON.parse(decrypted));
        return structuredClone(this.cache);
      } catch (error) {
        firstError ??= error;
      }
    }
    // Secure storage works but neither copy decrypts: these bytes will never
    // be readable with this key, and every save would fail on them. Set them
    // aside (never delete) and start empty so the person can re-enter keys.
    await this.setAsideUnreadableFiles(firstError);
    this.cache = emptySettings();
    return structuredClone(this.cache);
  }

  private async setAsideUnreadableFiles(cause: unknown): Promise<void> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    for (const candidate of [this.filePath, this.backupPath()]) {
      if (!existsSync(candidate)) continue;
      let target = `${candidate}.unreadable-${stamp}`;
      for (let suffix = 1; existsSync(target); suffix += 1) target = `${candidate}.unreadable-${stamp}-${suffix}`;
      try {
        await rename(candidate, target);
      } catch (error) {
        throw new Error(`AmpleFile could not read secure settings (${errorMessage(cause)}) or set them aside: ${errorMessage(error)}`);
      }
    }
    this.credentialsSetAside = true;
    console.warn(`AmpleFile could not decrypt saved provider credentials and set them aside; re-enter them in Settings → AI Models. (${errorMessage(cause)})`);
  }

  private async write(data: SecureSettingsFile): Promise<void> {
    this.assertEncryptionAvailable();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, this.safeStorage.encryptString(JSON.stringify(data)));
    try {
      if (existsSync(this.filePath)) await copyFile(this.filePath, this.backupPath());
      await rename(temporaryPath, this.filePath);
      this.cache = structuredClone(data);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Operating-system secure storage is not available for this session.");
    }
  }
}

function normalizeSettings(value: unknown): SecureSettingsFile {
  if (!value || typeof value !== "object") return emptySettings();
  const record = value as Partial<SecureSettingsFile>;
  return {
    schemaVersion: 2,
    credentials: credentialRecord(record.credentials),
  };
}

function credentialRecord(value: unknown): PiAuthStorageData {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => {
    const credential = entry[1];
    if (!credential || typeof credential !== "object") return false;
    const record = credential as { type?: unknown; key?: unknown };
    return (record.type === "api_key" && typeof record.key === "string") || record.type === "oauth";
  })) as PiAuthStorageData;
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLocaleLowerCase();
  if (!provider || !/^[a-z0-9._-]+$/.test(provider)) throw new Error("Invalid provider name.");
  return provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
