import type { Box, FileData, FileManifest, FileRecord } from './types';

/** Keys never cross the API boundary except inside an authenticated encrypted keyBox. */
export interface Keyring { currentEpoch: number; keys: Record<string, string> }
const text = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const iterations = 600_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;
const context = (...parts: unknown[]) => text.encode(JSON.stringify(['flint', 1, ...parts]));

export function validateKeyring(value: unknown, expectedEpoch?: number): Keyring {
  const ring = value as Keyring;
  if (!ring || !Number.isSafeInteger(ring.currentEpoch) || ring.currentEpoch < 1 || !ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys)) throw new Error('Invalid vault keyring');
  if (expectedEpoch !== undefined && ring.currentEpoch !== expectedEpoch) throw new Error('Vault key epoch does not match');
  const entries = Object.entries(ring.keys);
  if (entries.length < 1 || entries.length > 1000 || !Object.hasOwn(ring.keys, String(ring.currentEpoch))) throw new Error('Invalid vault keyring');
  for (const [epoch, key] of entries) {
    if (!/^[1-9]\d*$/.test(epoch) || Number(epoch) > ring.currentEpoch || base64ToBytes(key).length !== 32) throw new Error('Invalid vault key');
  }
  return { currentEpoch: ring.currentEpoch, keys: { ...ring.keys } };
}
async function contentKey(keyring: Keyring, epoch: number): Promise<CryptoKey> {
  const encoded = keyring.keys[String(epoch)];
  if (!encoded) throw new Error(`Vault key epoch ${epoch} is unavailable; unlock again`);
  const bytes = base64ToBytes(encoded);
  if (bytes.length !== 32) throw new Error('Invalid vault key');
  return crypto.subtle.importKey('raw', buffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function wrappingKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(salt);
  if (bytes.length !== 16) throw new Error('Invalid vault salt');
  const material = await crypto.subtle.importKey('raw', buffer(text.encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: buffer(bytes), iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(key: CryptoKey, bytes: Uint8Array, aad: Uint8Array): Promise<Box> {
  const iv = random(12);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad), tagLength: 128 }, key, buffer(bytes));
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
}
async function decrypt(key: CryptoKey, box: Box, aad: Uint8Array): Promise<Uint8Array> {
  const iv = base64ToBytes(box.iv), bytes = base64ToBytes(box.data);
  if (iv.length !== 12 || bytes.length < 16) throw new Error('Invalid encrypted envelope');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad), tagLength: 128 }, key, buffer(bytes)));
}
async function wrapKeyring(vaultId: string, passphrase: string, keyring: Keyring) {
  if (passphrase.length < 12) throw new Error('Choose a vault unlock passphrase with at least 12 characters');
  const salt = bytesToBase64(random(16));
  const keyBox = await encrypt(await wrappingKey(passphrase, salt), text.encode(JSON.stringify(keyring)), context('keyring', vaultId, keyring.currentEpoch));
  return { salt, keyBox, keyring };
}
export async function createVaultCrypto(vaultId: string, passphrase: string) {
  return wrapKeyring(vaultId, passphrase, { currentEpoch: 1, keys: { '1': bytesToBase64(random(32)) } });
}
export async function unlockVault(vaultId: string, epoch: number, salt: string, keyBox: Box, passphrase: string): Promise<Keyring> {
  const raw = await decrypt(await wrappingKey(passphrase, salt), keyBox, context('keyring', vaultId, epoch));
  return validateKeyring(JSON.parse(decoder.decode(raw)), epoch);
}
export async function rotateVaultCrypto(vaultId: string, keyring: Keyring, newPassphrase: string) {
  const old = validateKeyring(keyring);
  const epoch = old.currentEpoch + 1;
  const next = { currentEpoch: epoch, keys: { ...old.keys, [epoch]: bytesToBase64(random(32)) } };
  return { ...await wrapKeyring(vaultId, newPassphrase, next), epoch };
}

/** Domain-separated encryption for durable encrypted browser/bridge outboxes. */
export async function encryptValue(valueContext: string, value: unknown, keyring: Keyring, epoch = keyring.currentEpoch): Promise<Box> {
  return encrypt(await contentKey(keyring, epoch), text.encode(JSON.stringify(value)), context('value', valueContext, epoch));
}
export async function decryptValue<T = unknown>(valueContext: string, box: Box, keyring: Keyring, epoch = keyring.currentEpoch): Promise<T> {
  return JSON.parse(decoder.decode(await decrypt(await contentKey(keyring, epoch), box, context('value', valueContext, epoch)))) as T;
}
export async function encryptFile(vaultId: string, fileId: string, revision: number, deleted: boolean, data: FileData, keyring: Keyring): Promise<Box> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid file revision');
  return encrypt(await contentKey(keyring, keyring.currentEpoch), text.encode(JSON.stringify(data)), context('file', vaultId, fileId, revision, keyring.currentEpoch, deleted));
}
export async function decryptFile(record: FileRecord, keyring: Keyring): Promise<FileData> {
  const raw = await decrypt(await contentKey(keyring, record.epoch), record.box, context('file', record.vaultId, record.id, record.revision, record.epoch, record.deleted));
  const value = JSON.parse(decoder.decode(raw)) as FileData;
  if (!value || typeof value.path !== 'string' || typeof value.content !== 'string') throw new Error('Invalid decrypted file');
  if (value.attachment && (!Array.isArray(value.attachment.chunks) || !Number.isSafeInteger(value.attachment.size) || value.attachment.size < 0 || value.attachment.size > 200 * 1024 * 1024 || typeof value.attachment.mime !== 'string' || value.attachment.mime.length > 255 || !Number.isSafeInteger(value.attachment.epoch) || value.attachment.epoch < 1 || value.attachment.epoch > keyring.currentEpoch || value.attachment.chunks.length > 200 || value.attachment.chunks.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) throw new Error('Invalid attachment manifest');
  return value;
}
export interface ManifestData { path: string; attachment?: { mime: string; size: number } }
/** A small, separately authenticated header lets clients select paths without downloading note bodies. */
export async function encryptManifest(vaultId: string, fileId: string, revision: number, deleted: boolean, data: FileData, keyring: Keyring): Promise<Box> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid file revision');
  const manifest: ManifestData = { path: data.path };
  if (data.attachment) manifest.attachment = { mime: data.attachment.mime, size: data.attachment.size };
  return encrypt(await contentKey(keyring, keyring.currentEpoch), text.encode(JSON.stringify(manifest)), context('manifest', vaultId, fileId, revision, keyring.currentEpoch, deleted));
}
export async function decryptManifest(record: FileManifest, keyring: Keyring): Promise<ManifestData> {
  if (!record.manifestBox) throw new Error('This legacy file has no separate encrypted manifest');
  const raw = await decrypt(await contentKey(keyring, record.epoch), record.manifestBox, context('manifest', record.vaultId, record.id, record.revision, record.epoch, record.deleted));
  const value = JSON.parse(decoder.decode(raw)) as ManifestData;
  if (!value || typeof value.path !== 'string' || Object.keys(value).some(key => key !== 'path' && key !== 'attachment')) throw new Error('Invalid encrypted file manifest');
  if (value.attachment && (typeof value.attachment.mime !== 'string' || value.attachment.mime.length > 255 || !Number.isSafeInteger(value.attachment.size) || value.attachment.size < 0 || value.attachment.size > 200 * 1024 * 1024 || Object.keys(value.attachment).some(key => key !== 'mime' && key !== 'size'))) throw new Error('Invalid encrypted attachment manifest');
  return value;
}
export async function encryptChunk(vaultId: string, chunkId: string, bytes: Uint8Array, keyring: Keyring): Promise<Uint8Array> {
  const box = await encrypt(await contentKey(keyring, keyring.currentEpoch), bytes, context('chunk', vaultId, chunkId, keyring.currentEpoch));
  const iv = base64ToBytes(box.iv), ciphertext = base64ToBytes(box.data), result = new Uint8Array(iv.length + ciphertext.length);
  result.set(iv); result.set(ciphertext, iv.length);
  return result;
}
export async function decryptChunk(vaultId: string, chunkId: string, bytes: Uint8Array, keyring: Keyring, epoch: number): Promise<Uint8Array> {
  if (bytes.length < 28) throw new Error('Invalid encrypted chunk');
  return decrypt(await contentKey(keyring, epoch), { iv: bytesToBase64(bytes.subarray(0, 12)), data: bytesToBase64(bytes.subarray(12)) }, context('chunk', vaultId, chunkId, epoch));
}
