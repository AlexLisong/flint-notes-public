import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { base64ToBytes, bytesToBase64, createVaultCrypto, decryptChunk, decryptFile, decryptManifest, decryptValue, encryptChunk, encryptFile, encryptManifest, encryptValue, rotateVaultCrypto, unlockVault } from '../shared/crypto';
import type { FileRecord } from '../shared/types';

test('vault unlock and cross-runtime WebCrypto data survive Unicode/unknown Markdown', async () => {
  const id = randomUUID(), fileId = randomUUID(), passphrase = 'my long unrelated vault phrase';
  const created = await createVaultCrypto(id, passphrase), ring = await unlockVault(id, 1, created.salt, created.keyBox, passphrase);
  assert.deepEqual(ring, created.keyring);
  const data = { path: '知识/你好.md', content: '---\nunknown: preserved\n---\n# Hi\n[[Other#heading|alias]]\n^block\n🌱' };
  const box = await encryptFile(id, fileId, 1, false, data, ring);
  const record: FileRecord = { id: fileId, vaultId: id, revision: 1, epoch: 1, deleted: false, box, updatedAt: '', seq: 1 };
  assert.deepEqual(await decryptFile(record, ring), data);
  // Independent Node API decrypts the browser-compatible wire envelope and exact AAD.
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(ring.keys['1'], 'base64'), 'AES-GCM', false, ['decrypt']);
  const raw = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64'), additionalData: Buffer.from(JSON.stringify(['flint', 1, 'file', id, fileId, 1, 1, false])) }, key, Buffer.from(box.data, 'base64'));
  assert.deepEqual(JSON.parse(Buffer.from(raw).toString('utf8')), data);
});
test('wrong passphrase, vault identity, altered payload, revision, tombstone and epoch all fail authentication', async () => {
  const vaultId = randomUUID(), fileId = randomUUID(), created = await createVaultCrypto(vaultId, 'the correct unlock phrase');
  await assert.rejects(unlockVault(vaultId, 1, created.salt, created.keyBox, 'this phrase is incorrect'));
  await assert.rejects(unlockVault(randomUUID(), 1, created.salt, created.keyBox, 'the correct unlock phrase'));
  const box = await encryptFile(vaultId, fileId, 1, false, { path: 'Private.md', content: 'Secret' }, created.keyring);
  const record: FileRecord = { id: fileId, vaultId, revision: 1, epoch: 1, deleted: false, box, seq: 1, updatedAt: '' };
  for (const patch of [{ vaultId: randomUUID() }, { id: randomUUID() }, { revision: 2 }, { deleted: true }, { epoch: 2 }]) await assert.rejects(decryptFile({ ...record, ...patch }, created.keyring));
  const damaged = base64ToBytes(box.data); damaged[0] ^= 1;
  await assert.rejects(decryptFile({ ...record, box: { ...box, data: bytesToBase64(damaged) } }, created.keyring));
  const second = await encryptFile(vaultId, fileId, 1, false, { path: 'Private.md', content: 'Secret' }, created.keyring);
  assert.notEqual(second.iv, box.iv);
});
test('key rotation preserves historical reads while old credentials cannot read future content', async () => {
  const vaultId = randomUUID(), fileId = randomUUID(), old = await createVaultCrypto(vaultId, 'original vault unlock phrase');
  const historical: FileRecord = { id: fileId, vaultId, revision: 1, epoch: 1, deleted: false, box: await encryptFile(vaultId, fileId, 1, false, { path: 'Note.md', content: 'old' }, old.keyring), seq: 1, updatedAt: '' };
  const rotated = await rotateVaultCrypto(vaultId, old.keyring, 'a newly distributed unlock phrase');
  assert.equal(old.keyring.currentEpoch, 1); assert.equal(rotated.epoch, 2); assert.equal((await decryptFile(historical, rotated.keyring)).content, 'old');
  await assert.rejects(unlockVault(vaultId, 2, rotated.salt, rotated.keyBox, 'original vault unlock phrase'));
  assert.deepEqual(await unlockVault(vaultId, 2, rotated.salt, rotated.keyBox, 'a newly distributed unlock phrase'), rotated.keyring);
  const current = { ...historical, revision: 2, epoch: 2, box: await encryptFile(vaultId, fileId, 2, false, { path: 'Note.md', content: 'new' }, rotated.keyring) };
  await assert.rejects(decryptFile(current, old.keyring));
});
test('binary chunks round-trip exactly and cannot be substituted across IDs or vaults', async () => {
  const vaultId = randomUUID(), id = randomUUID(), { keyring } = await createVaultCrypto(vaultId, 'large attachment unlock phrase');
  const bytes = new Uint8Array(1024 * 1024); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const ciphertext = await encryptChunk(vaultId, id, bytes, keyring);
  assert.equal(ciphertext.length, bytes.length + 28); assert.deepEqual(await decryptChunk(vaultId, id, ciphertext, keyring, 1), bytes);
  await assert.rejects(decryptChunk(vaultId, randomUUID(), ciphertext, keyring, 1));
  await assert.rejects(decryptChunk(randomUUID(), id, ciphertext, keyring, 1));
  await assert.rejects(decryptChunk(vaultId, id, ciphertext.subarray(0, ciphertext.length - 1), keyring, 1));
});
test('durable value envelopes authenticate namespace and validate malformed manifests', async () => {
  const vaultId = randomUUID(), { keyring } = await createVaultCrypto(vaultId, 'outbox encrypting passphrase');
  const envelope = await encryptValue(`outbox:${vaultId}`, { note: 'unsaved private edit' }, keyring);
  assert.deepEqual(await decryptValue(`outbox:${vaultId}`, envelope, keyring), { note: 'unsaved private edit' });
  await assert.rejects(decryptValue(`outbox:${randomUUID()}`, envelope, keyring));
  const fileId = randomUUID(), box = await encryptFile(vaultId, fileId, 1, false, { path: 'Bad.bin', content: '', attachment: { mime: 'application/octet-stream', size: 1, epoch: 0, chunks: ['../outside'] } }, keyring);
  await assert.rejects(decryptFile({ id: fileId, vaultId, box, revision: 1, epoch: 1, deleted: false, seq: 1, updatedAt: '' }, keyring), /manifest/);
});
test('separate manifests reveal only selected metadata and authenticate revision/file identity', async () => {
  const vaultId = randomUUID(), id = randomUUID(), { keyring } = await createVaultCrypto(vaultId, 'private manifest unlock phrase');
  const data = { path: 'Private/Attachment.pdf', content: 'This note body must not be in the manifest', attachment: { mime: 'application/pdf', size: 456, epoch: 1, chunks: [randomUUID()] } };
  const manifestBox = await encryptManifest(vaultId, id, 1, false, data, keyring);
  const header = { id, vaultId, revision: 1, epoch: 1, deleted: false, manifestBox, seq: 1, updatedAt: '' };
  assert.deepEqual(await decryptManifest(header, keyring), { path: data.path, attachment: { mime: 'application/pdf', size: 456 } });
  await assert.rejects(decryptManifest({ ...header, revision: 2 }, keyring));
  await assert.rejects(decryptManifest({ ...header, id: randomUUID() }, keyring));
  await assert.rejects(decryptManifest({ ...header, deleted: true }, keyring));
  const body = await encryptFile(vaultId, id, 1, false, data, keyring);
  await assert.rejects(decryptManifest({ ...header, manifestBox: body }, keyring));
});
