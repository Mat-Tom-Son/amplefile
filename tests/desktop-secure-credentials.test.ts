import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PackagedPiRuntimeProvider } from "../desktop/src/pi-runtime.js";
import { SecureSettingsStore, type SafeStorageLike } from "../desktop/src/settings.js";
import type { PiAuthStorageData } from "../src/local/agent/auth-storage.js";

/** Reversible stand-in for Safe Storage; never touches the Keychain. */
class FakeSafeStorage implements SafeStorageLike {
  available = true;
  backend = "gnome_libsecret";
  getSelectedStorageBackend(): string { return this.backend; }
  key = "key-1";
  /** Replaces decryption with this failure, as Electron reports it. */
  decryptFailure: string | null = null;
  /** Secure storage turns out to be unavailable once a decryption fails. */
  unavailableAfterFailure = false;
  isEncryptionAvailable(): boolean { return this.available; }
  encryptString(plainText: string): Buffer {
    return Buffer.from(`${this.key}:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    if (this.decryptFailure) {
      if (this.unavailableAfterFailure) this.available = false;
      throw new Error(this.decryptFailure);
    }
    const [key, body] = encrypted.toString("utf8").split(":");
    if (key !== this.key || body === undefined) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    return Buffer.from(body, "base64").toString("utf8");
  }
}

async function tempRoot(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amplefile-secure-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const fixedNow = () => new Date("2026-11-09T12:00:00.000Z");

test("secure settings round-trip through the injected safe storage", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  await new SecureSettingsStore(file, { safeStorage }).setProviderApiKey("openai", "sk-test-1");

  const reopened = new SecureSettingsStore(file, { safeStorage });
  assert.equal(await reopened.getProviderApiKey("openai"), "sk-test-1");
  assert.deepEqual(await reopened.status(), { encryptionAvailable: true, configuredProviders: ["openai"], credentialsNeedReentry: false });
});

test("undecryptable settings and backup are set aside, never deleted, and a new key can be saved", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  const first = new SecureSettingsStore(file, { safeStorage });
  await first.setProviderApiKey("openai", "sk-old-1");
  await first.setProviderApiKey("anthropic", "sk-old-2");
  const oldMain = await readFile(file);
  const oldBackup = await readFile(`${file}.bak`);

  // The Safe Storage key changed (for example after a reset): nothing decrypts.
  safeStorage.key = "key-2";
  const store = new SecureSettingsStore(file, { safeStorage, now: fixedNow });
  const status = await store.status();
  assert.deepEqual(status, { encryptionAvailable: true, configuredProviders: [], credentialsNeedReentry: true });

  const stamp = "2026-11-09T12-00-00-000Z";
  assert.deepEqual(await readFile(`${file}.unreadable-${stamp}`), oldMain);
  assert.deepEqual(await readFile(`${file}.bak.unreadable-${stamp}`), oldBackup);

  // The request to re-enter credentials survives a restart.
  const restarted = new SecureSettingsStore(file, { safeStorage });
  assert.deepEqual(await restarted.status(), { encryptionAvailable: true, configuredProviders: [], credentialsNeedReentry: true });
  safeStorage.available = false;
  assert.equal((await restarted.status()).credentialsNeedReentry, true);
  safeStorage.available = true;

  // Saving credentials again answers it; the old copies are kept, marked superseded.
  await restarted.setProviderApiKey("openai", "sk-new");
  const reopened = new SecureSettingsStore(file, { safeStorage });
  assert.equal(await reopened.getProviderApiKey("openai"), "sk-new");
  assert.deepEqual(await reopened.status(), { encryptionAvailable: true, configuredProviders: ["openai"], credentialsNeedReentry: false });
  assert.deepEqual(await readFile(`${file}.unreadable-${stamp}.superseded`), oldMain);
  assert.deepEqual(await readFile(`${file}.bak.unreadable-${stamp}.superseded`), oldBackup);
});

test("a readable backup still wins over a corrupt main file", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  const store = new SecureSettingsStore(file, { safeStorage });
  await store.setProviderApiKey("openai", "sk-1");
  await store.setProviderApiKey("openai", "sk-2");
  await writeFile(file, "garbage");

  const reopened = new SecureSettingsStore(file, { safeStorage });
  assert.equal(await reopened.getProviderApiKey("openai"), "sk-1");
  assert.equal((await reopened.status()).credentialsNeedReentry, false);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes("unreadable")), []);
});

test("unavailable secure storage is transient: nothing is set aside and a later read succeeds", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  await new SecureSettingsStore(file, { safeStorage }).setProviderApiKey("openai", "sk-1");

  safeStorage.available = false;
  const store = new SecureSettingsStore(file, { safeStorage });
  await assert.rejects(store.load(), /secure storage is not available/i);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes("unreadable")), []);

  safeStorage.available = true;
  assert.deepEqual(await store.load(), { openai: { type: "api_key", key: "sk-1" } });
});

test("a failed credential load is retried instead of disabling credentials until restart", async (t) => {
  const root = await tempRoot(t);
  let attempts = 0;
  let saved: PiAuthStorageData = { openai: { type: "api_key", key: "sk-test" } };
  const host = {
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("User denied Keychain access.");
      return structuredClone(saved);
    },
    save: async (data: PiAuthStorageData) => { saved = structuredClone(data); },
  };
  const provider = new PackagedPiRuntimeProvider({ agentDir: join(root, "pi"), authStorageHost: host });
  const folder = join(root, "folder");

  await assert.rejects(provider.resolveRuntime(folder), /denied Keychain access/);
  await provider.flush();
  const runtime = await provider.resolveRuntime(folder);
  assert.equal(attempts, 2);
  assert.equal((await runtime.credentials.read("openai"))?.type, "api_key");
  await provider.resolveRuntime(folder);
  assert.equal(attempts, 2, "a successful load stays cached");
});

async function unreadableNames(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes("unreadable"));
}

test("an I/O error on the settings file never sets credentials aside and is retried", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  const first = new SecureSettingsStore(file, { safeStorage });
  await first.setProviderApiKey("openai", "sk-1");
  await first.setProviderApiKey("openai", "sk-2");

  // The main file cannot be read as a file (EISDIR stands in for EIO/EMFILE/EACCES)
  // and the backup is corrupt: the store must refuse, not start empty.
  await rename(file, join(root, "held.bin"));
  await mkdir(file);
  await writeFile(`${file}.bak`, "garbage");
  const store = new SecureSettingsStore(file, { safeStorage });
  await assert.rejects(store.load(), /could not read secure settings/);
  assert.deepEqual(await unreadableNames(root), []);

  await rm(file, { recursive: true });
  await rename(join(root, "held.bin"), file);
  assert.equal(await store.getProviderApiKey("openai"), "sk-2");
});

test("Electron's \"Decryption is not available\" is temporary, not corruption", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  await new SecureSettingsStore(file, { safeStorage }).setProviderApiKey("openai", "sk-1");

  safeStorage.decryptFailure = "Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.";
  const store = new SecureSettingsStore(file, { safeStorage });
  await assert.rejects(store.load(), /could not decrypt settings right now/);
  assert.deepEqual(await unreadableNames(root), []);

  safeStorage.decryptFailure = null;
  assert.equal(await store.getProviderApiKey("openai"), "sk-1");
});

test("a decryption failure while secure storage goes away leaves the files alone", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  await new SecureSettingsStore(file, { safeStorage }).setProviderApiKey("openai", "sk-1");

  safeStorage.decryptFailure = "Error while decrypting the ciphertext provided to safeStorage.decryptString.";
  safeStorage.unavailableAfterFailure = true;
  await assert.rejects(new SecureSettingsStore(file, { safeStorage }).load());
  assert.deepEqual(await unreadableNames(root), []);
});

test("concurrent first reads share one read and set unreadable files aside once", async (t) => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  const first = new SecureSettingsStore(file, { safeStorage });
  await first.setProviderApiKey("openai", "sk-1");
  await first.setProviderApiKey("openai", "sk-2");

  safeStorage.key = "key-2";
  const store = new SecureSettingsStore(file, { safeStorage, now: fixedNow });
  const [status, loaded, key] = await Promise.all([store.status(), store.load(), store.getProviderApiKey("openai")]);
  assert.equal(status.credentialsNeedReentry, true);
  assert.equal(loaded, undefined);
  assert.equal(key, undefined);
  assert.deepEqual((await unreadableNames(root)).sort(), [
    "secure-settings.bin.bak.unreadable-2026-11-09T12-00-00-000Z",
    "secure-settings.bin.unreadable-2026-11-09T12-00-00-000Z",
  ]);
});


test("Linux plaintext fallback cannot read or replace encrypted credentials", { skip: process.platform !== "linux" }, async t => {
  const root = await tempRoot(t);
  const safeStorage = new FakeSafeStorage();
  const file = join(root, "secure-settings.bin");
  await new SecureSettingsStore(file, { safeStorage }).setProviderApiKey("openai", "sk-test-encrypted");
  const encrypted = await readFile(file);
  safeStorage.backend = "basic_text";
  const reopened = new SecureSettingsStore(file, { safeStorage });
  assert.equal((await reopened.status()).encryptionAvailable, false);
  await assert.rejects(reopened.setProviderApiKey("openai", "sk-test-replacement"), /keyring/i);
  assert.deepEqual(await readFile(file), encrypted);
});
