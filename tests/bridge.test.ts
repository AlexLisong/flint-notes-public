import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../server/app';
import { createVaultCrypto, decryptFile, encryptFile, encryptManifest, rotateVaultCrypto, type Keyring } from '../shared/crypto';
import { BridgeEngine, RotationRequiredError, readState, safeRelativePath, checkedPath, scanFolder, type BridgeConfig, type Pairing } from '../bridge/engine';
import { loadPairing, savePairing, validatePairing } from '../bridge/secrets';
import type { FileRecord, FileWrite } from '../shared/types';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flint-bridge-')), folder = path.join(root, 'vault'), stateDir = path.join(root, 'state'); await fs.mkdir(folder);
  const { app, db } = createApp({ dataDir: path.join(root, 'server'), origin: 'http://localhost:5191', bootstrapCode: 'bridge-test-registration', disableRateLimit: true });
  const owner = request.agent(app), registered = await owner.post('/api/auth/register').send({ name: 'Bridge owner', email: 'bridge@example.test', password: 'a long account login password', code: 'bridge-test-registration' }).expect(201), csrf = registered.body.csrf;
  const vaultId = randomUUID(), crypt = await createVaultCrypto(vaultId, 'a distinct vault unlock passphrase');
  await owner.post('/api/vaults').set('X-CSRF-Token', csrf).send({ id: vaultId, name: 'Bridge test', salt: crypt.salt, keyBox: crypt.keyBox }).expect(201);
  const device = await owner.post('/api/devices').set('X-CSRF-Token', csrf).send({ name: 'Test companion', vaultId }).expect(201);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const pairing: Pairing = { server: `http://127.0.0.1:${port}`, vaultId, token: device.body.token, keyring: crypt.keyring };
  const config: BridgeConfig = { server: pairing.server, vaultId, folder, stateDir };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const engine = (settings: Partial<BridgeConfig> = {}, keyring: Keyring = crypt.keyring) => new BridgeEngine({ ...config, ...settings }, { ...pairing, keyring });
  const write = async (relative: string, content: string, prior?: FileRecord, deleted = false, keyring = crypt.keyring) => {
    const id = prior?.id || randomUUID(), baseRevision = prior?.revision || 0;
    const mutation: FileWrite = { id, baseRevision, epoch: keyring.currentEpoch, deleted, mutationId: randomUUID(), box: await encryptFile(vaultId, id, baseRevision + 1, deleted, { path: relative, content }, keyring), manifestBox: await encryptManifest(vaultId, id, baseRevision + 1, deleted, { path: relative, content }, keyring) };
    return (await owner.put(`/api/vaults/${vaultId}/files/${id}`).set('X-CSRF-Token', csrf).send(mutation).expect(200)).body.file as FileRecord;
  };
  const remote = async () => (await owner.get(`/api/vaults/${vaultId}/files?after=0`).expect(200)).body.files as FileRecord[];
  return { root, folder, config, pairing, engine, write, remote, owner, csrf, vaultId, crypt, db };
}
async function contents(folder: string) {
  const result: Record<string, string> = {};
  for (const file of await fs.readdir(folder)) if ((await fs.stat(path.join(folder, file))).isFile()) result[file] = await fs.readFile(path.join(folder, file), 'utf8');
  return result;
}
function failNextWrite(engine: BridgeEngine, afterCommit = false) {
  const mutable = engine as unknown as { request: (endpoint: string, init?: RequestInit) => Promise<Response> };
  const original = mutable.request.bind(engine); let fail = true;
  mutable.request = async (endpoint, init) => {
    if (fail && init?.method === 'PUT' && endpoint.includes('/files/')) {
      fail = false; if (afterCommit) await original(endpoint, init); throw new Error(afterCommit ? 'Connection lost after commit' : 'Device is offline');
    }
    return original(endpoint, init);
  };
}
test('first pairing with an empty folder downloads remote files without deleting anything', async t => {
  const f = await fixture(t), head = await f.write('Existing.md', 'already on the service');
  await f.engine().syncOnce();
  assert.equal(await fs.readFile(path.join(f.folder, 'Existing.md'), 'utf8'), 'already on the service');
  assert.equal((await f.remote())[0].revision, head.revision); assert.equal((await f.remote())[0].deleted, false);
});
test('initial same-name files preserve local and remote content, then converge on another device', async t => {
  const f = await fixture(t); await f.write('Note.md', 'remote content'); await fs.writeFile(path.join(f.folder, 'Note.md'), 'local content');
  await f.engine().syncOnce();
  assert.deepEqual(Object.values(await contents(f.folder)).sort(), ['local content', 'remote content']);
  const otherFolder = path.join(f.root, 'second-vault'); await fs.mkdir(otherFolder);
  await f.engine({ folder: otherFolder, stateDir: path.join(f.root, 'second-state') }).syncOnce();
  assert.deepEqual(Object.values(await contents(otherFolder)).sort(), ['local content', 'remote content']);
});
test('automatic cycles upload local changes, download web changes, preserve rename identity and sync deletions', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.folder, 'Note.md'), 'local first'); await f.engine().syncOnce();
  let head = (await f.remote())[0]; assert.equal((await decryptFile(head, f.crypt.keyring)).content, 'local first');
  await fs.rename(path.join(f.folder, 'Note.md'), path.join(f.folder, 'Renamed.md')); await f.engine().syncOnce();
  head = (await f.remote())[0]; assert.equal((await f.remote()).length, 1); assert.equal((await decryptFile(head, f.crypt.keyring)).path, 'Renamed.md');
  head = await f.write('Moved.md', 'edited in browser', head); await f.engine().syncOnce();
  assert.equal(await fs.readFile(path.join(f.folder, 'Moved.md'), 'utf8'), 'edited in browser'); await assert.rejects(fs.stat(path.join(f.folder, 'Renamed.md')));
  await fs.unlink(path.join(f.folder, 'Moved.md')); await f.engine().syncOnce(); assert.equal((await f.remote())[0].deleted, true);
});
test('missing or unreadable source folder never generates remote deletions', async t => {
  const f = await fixture(t); await f.write('Safe.md', 'keep this note'); await f.engine().syncOnce();
  await fs.rename(f.folder, f.folder + '-moved'); await assert.rejects(f.engine().syncOnce()); assert.equal((await f.remote())[0].deleted, false);
  await fs.rename(f.folder + '-moved', f.folder);
  if (process.getuid?.() !== 0) {
    await fs.chmod(f.folder, 0);
    try { await assert.rejects(f.engine().syncOnce()); } finally { await fs.chmod(f.folder, 0o700); }
    assert.equal((await f.remote())[0].deleted, false);
  }
  await fs.rename(f.folder, f.folder + '-old'); await fs.mkdir(f.folder);
  await assert.rejects(f.engine().syncOnce(), /replaced or remounted/); assert.equal((await f.remote())[0].deleted, false);
});
test('excluded folders and attachment types are not downloaded or mistaken for deletion', async t => {
  const f = await fixture(t), visible = await f.write('Visible.md', 'visible'), hidden = await f.write('Private/Hidden.md', 'excluded');
  const engine = f.engine({ excludes: ['Private'], extensions: ['md'] }), requests: string[] = [];
  const mutable = engine as unknown as { request: (endpoint: string, init?: RequestInit) => Promise<Response> }, original = mutable.request.bind(engine);
  mutable.request = async (endpoint, init) => { requests.push(endpoint); return original(endpoint, init); };
  await engine.syncOnce();
  assert(requests.some(endpoint => endpoint.includes('/manifests?')));
  assert(requests.some(endpoint => endpoint.includes(`/files/${visible.id}?revision=1`)));
  assert(!requests.some(endpoint => endpoint.includes(`/files/${hidden.id}`)), 'Excluded note ciphertext must never be downloaded');
  assert(!requests.some(endpoint => endpoint.includes('/files?')), 'The companion must not fetch the old full-body listing');
  assert.equal(await fs.readFile(path.join(f.folder, 'Visible.md'), 'utf8'), 'visible'); await assert.rejects(fs.stat(path.join(f.folder, 'Private')));
  await f.engine({ excludes: ['Private', 'Visible.md'], extensions: ['md'] }).syncOnce();
  assert((await f.remote()).every(file => !file.deleted));
});
test('legacy records can sync and selected manifest/body mismatches are rejected', async t => {
  const f = await fixture(t), legacyId = randomUUID();
  await f.owner.put(`/api/vaults/${f.vaultId}/files/${legacyId}`).set('X-CSRF-Token', f.csrf).send({ id: legacyId, baseRevision: 0, epoch: 1, mutationId: randomUUID(), deleted: false, box: await encryptFile(f.vaultId, legacyId, 1, false, { path: 'Legacy.md', content: 'legacy note' }, f.crypt.keyring) }).expect(200);
  await f.engine().syncOnce(); assert.equal(await fs.readFile(path.join(f.folder, 'Legacy.md'), 'utf8'), 'legacy note');
  const wrongId = randomUUID();
  await f.owner.put(`/api/vaults/${f.vaultId}/files/${wrongId}`).set('X-CSRF-Token', f.csrf).send({ id: wrongId, baseRevision: 0, epoch: 1, mutationId: randomUUID(), deleted: false, box: await encryptFile(f.vaultId, wrongId, 1, false, { path: 'Hidden/Note.md', content: 'mismatch' }, f.crypt.keyring), manifestBox: await encryptManifest(f.vaultId, wrongId, 1, false, { path: 'Visible.md', content: '' }, f.crypt.keyring) }).expect(200);
  await assert.rejects(f.engine().syncOnce(), /does not match/); await assert.rejects(fs.stat(path.join(f.folder, 'Hidden')));
});
test('selection fetches the immutable chosen revision during a concurrent move into an excluded folder', async t => {
  const f = await fixture(t), initial = await f.write('Visible.md', 'version chosen by the manifest');
  const engine = f.engine({ excludes: ['Private'] }), requests: string[] = [];
  const mutable = engine as unknown as { request: (endpoint: string, init?: RequestInit) => Promise<Response> }, original = mutable.request.bind(engine); let moved = false;
  mutable.request = async (endpoint, init) => {
    requests.push(endpoint); const response = await original(endpoint, init);
    if (!moved && endpoint.includes('/manifests?')) { moved = true; await f.write('Private/Hidden.md', 'new excluded contents', initial); }
    return response;
  };
  await engine.syncOnce(); await engine.syncOnce();
  assert.equal(await fs.readFile(path.join(f.folder, 'Visible.md'), 'utf8'), 'version chosen by the manifest');
  assert(!requests.some(endpoint => endpoint.includes(`/files/${initial.id}?revision=2`)), 'New excluded ciphertext must not be downloaded');
  assert.equal((await f.remote()).length, 1, 'The parked old local path must not be uploaded as a new file');
  assert.equal((await f.remote())[0].revision, 2);
});
test('durable outbox retries a lost successful response without duplicating revisions', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.folder, 'Note.md'), 'committed once');
  const first = f.engine(); failNextWrite(first, true); await assert.rejects(first.syncOnce(), /after commit/);
  assert.equal((await readState(f.config.stateDir)).pending.length, 1);
  assert(!JSON.stringify(await readState(f.config.stateDir)).includes('committed once'));
  await f.engine().syncOnce(); assert.equal((await f.remote())[0].revision, 1); assert.equal((await readState(f.config.stateDir)).pending.length, 0);
});
test('offline queued edits and later disk edits both survive process restart', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.folder, 'Note.md'), 'offline version one');
  const first = f.engine(); failNextWrite(first); await assert.rejects(first.syncOnce(), /offline/);
  await fs.writeFile(path.join(f.folder, 'Note.md'), 'offline version two'); await f.engine().syncOnce();
  const head = (await f.remote())[0]; assert.equal(head.revision, 2); assert.equal((await decryptFile(head, f.crypt.keyring)).content, 'offline version two');
  const history = await f.owner.get(`/api/vaults/${f.vaultId}/files/${head.id}/history`).expect(200); assert.equal((await decryptFile(history.body.files[1], f.crypt.keyring)).content, 'offline version one');
});
test('concurrent browser edit preserves the queued local content in a conflict file', async t => {
  const f = await fixture(t); const initial = await f.write('Note.md', 'baseline'); await f.engine().syncOnce();
  await fs.writeFile(path.join(f.folder, 'Note.md'), 'local offline edit'); const offline = f.engine(); failNextWrite(offline); await assert.rejects(offline.syncOnce());
  await f.write('Note.md', 'browser concurrent edit', initial); await f.engine().syncOnce();
  const values = Object.values(await contents(f.folder)); assert(values.includes('local offline edit')); assert.equal(await fs.readFile(path.join(f.folder, 'Note.md'), 'utf8'), 'browser concurrent edit');
});
test('remote deletion preserves locally modified note and keeps server tombstone', async t => {
  const f = await fixture(t); const head = await f.write('Note.md', 'baseline'); await f.engine().syncOnce();
  await fs.writeFile(path.join(f.folder, 'Note.md'), 'unsent local changes'); await f.write('Note.md', '', head, true); await f.engine().syncOnce();
  assert(Object.values(await contents(f.folder)).includes('unsent local changes')); assert((await f.remote()).some(file => file.id === head.id && file.deleted));
});
test('binary attachments use authenticated chunks and round-trip exact bytes across devices', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(1024 * 1024 + 143, 0xa7); bytes[41] = 0; bytes[42] = 255;
  await fs.writeFile(path.join(f.folder, 'Attachment.bin'), bytes); await f.engine().syncOnce();
  const data = await decryptFile((await f.remote())[0], f.crypt.keyring); assert.equal(data.attachment?.chunks.length, 2); assert.equal(data.attachment?.epoch, 1);
  const second = path.join(f.root, 'second-vault'); await fs.mkdir(second); await f.engine({ folder: second, stateDir: path.join(f.root, 'state-b') }).syncOnce();
  assert.deepEqual(await fs.readFile(path.join(second, 'Attachment.bin')), bytes);
});
test('stale epoch pauses with durable edits, fresh pairing reencrypts and resumes', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.folder, 'Note.md'), 'first version'); await f.engine().syncOnce();
  const rotated = await rotateVaultCrypto(f.vaultId, f.crypt.keyring, 'replacement member unlock phrase');
  await f.owner.post(`/api/vaults/${f.vaultId}/rotate`).set('X-CSRF-Token', f.csrf).send({ expectedEpoch: 1, epoch: 2, salt: rotated.salt, keyBox: rotated.keyBox }).expect(200);
  await fs.writeFile(path.join(f.folder, 'Note.md'), 'future private version'); await assert.rejects(f.engine().syncOnce(), RotationRequiredError);
  assert.equal((await readState(f.config.stateDir)).pending.length, 1); assert.equal(await fs.readFile(path.join(f.folder, 'Note.md'), 'utf8'), 'future private version');
  await f.engine({}, rotated.keyring).syncOnce(); const head = (await f.remote())[0]; assert.equal(head.epoch, 2); await assert.rejects(decryptFile(head, f.crypt.keyring)); assert.equal((await decryptFile(head, rotated.keyring)).content, 'future private version');
});
test('path traversal and symlink escapes are rejected before touching external files', async t => {
  const f = await fixture(t); for (const invalid of ['../escape.md', '/tmp/escape.md', 'a/../../bad', 'a\\..\\bad', 'C:/bad', 'a//b', '.git/config']) assert.throws(() => safeRelativePath(invalid));
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.md'), 'untouched'); await fs.symlink(outside, path.join(f.folder, 'alias'));
  await assert.rejects(checkedPath(f.folder, 'alias/keep.md'), /symlink/); await assert.rejects(scanFolder(f.config), /symlink/);
  await f.write('Should-not-download.md', 'preflight must finish before this write'); await assert.rejects(f.engine().syncOnce(), /symlink/); await assert.rejects(fs.stat(path.join(f.folder, 'Should-not-download.md')));
  await fs.unlink(path.join(f.folder, 'alias'));
  await f.write('../outside/keep.md', 'malicious path'); await assert.rejects(f.engine().syncOnce(), /Unsafe/); assert.equal(await fs.readFile(path.join(outside, 'keep.md'), 'utf8'), 'untouched');
});
test('secret dotfiles and repository metadata stay local; opt-in settings use a whitelist', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.folder, '.env'), 'DO_NOT_UPLOAD=secret'); await fs.writeFile(path.join(f.folder, '.env.production'), 'OTHER_SECRET=private');
  await fs.mkdir(path.join(f.folder, '.git')); await fs.writeFile(path.join(f.folder, '.git/config'), 'private git credential');
  await fs.mkdir(path.join(f.folder, '.obsidian')); await fs.writeFile(path.join(f.folder, '.obsidian/app.json'), '{"setting":true}');
  await fs.writeFile(path.join(f.folder, 'Visible.md'), 'ordinary note'); await f.engine().syncOnce();
  assert.equal((await f.remote()).length, 1);
  await f.engine({ obsidianSettings: true }).syncOnce(); const paths = await Promise.all((await f.remote()).map(async record => (await decryptFile(record, f.crypt.keyring)).path));
  assert.deepEqual(paths.sort(), ['.obsidian/app.json', 'Visible.md']);
});
test('UTF-8 BOM/CRLF and case-only remote renames preserve bytes and identity', async t => {
  const f = await fixture(t), original = Buffer.from('\ufeff---\r\nunknown: true\r\n---\r\n# Note\r\n'); await fs.writeFile(path.join(f.folder, 'Note.md'), original); await f.engine().syncOnce();
  const initial = (await f.remote())[0], plain = await decryptFile(initial, f.crypt.keyring); assert.deepEqual(Buffer.from(plain.content), original);
  await f.write('note.md', plain.content, initial); await f.engine().syncOnce();
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'note.md')), original); assert.equal((await f.remote()).length, 1); assert.equal((await f.remote())[0].deleted, false);
  assert((await fs.readdir(f.folder)).includes('note.md'));
});
test('pairing rejects remote HTTP and explicit file fallback enforces restrictive permissions', async t => {
  const f = await fixture(t); assert.throws(() => validatePairing({ ...f.pairing, server: 'http://example.com' }), /HTTPS/);
  await savePairing(f.config.stateDir, f.pairing, true); assert.deepEqual(await loadPairing(f.config.stateDir, true), f.pairing);
  await fs.chmod(path.join(f.config.stateDir, 'pairing-secret.json'), 0o644); await assert.rejects(loadPairing(f.config.stateDir, true), /0600/);
});
