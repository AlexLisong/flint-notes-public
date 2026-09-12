/** Live, reversible background test. Only creates/edits/deletes one uniquely named synthetic note. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicJson, readState, type Pairing } from '../bridge/engine';
import { validatePairing } from '../bridge/secrets';
import { decryptFile, decryptManifest, encryptFile, encryptManifest } from '../shared/crypto';
import type { FileManifest, FileRecord, FileWrite } from '../shared/types';

const exec = promisify(execFile), args = process.argv.slice(2);
const arg = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = arg('--profile', 'personal');
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(profile)) throw new Error('Invalid profile');
const pairingFile = path.resolve(arg('--pairing-file', path.join(project, '.data/aws/pairing.json')));
const pairing: Pairing = validatePairing(JSON.parse(await fs.readFile(pairingFile, 'utf8')));
const stateDir = path.join(process.env.FLINT_BRIDGE_HOME || path.join(os.homedir(), 'Library/Application Support/Flint/bridge'), profile);
const config = JSON.parse(await fs.readFile(path.join(stateDir, 'config.json'), 'utf8'));
if (config.vaultId !== pairing.vaultId || config.server !== pairing.server) throw new Error('Configured companion does not match this pairing');
const latest = JSON.parse(await fs.readFile(path.join(project, '.data/vault-backup/latest.json'), 'utf8'));
const checkpoint = JSON.parse(await fs.readFile(path.join(latest.backup, 'inventory.json'), 'utf8'));
if (checkpoint.folder !== config.folder) throw new Error('Private backup belongs to another folder');
const reservedDirectory = `Flint verification ${randomUUID()}`, relative = `${reservedDirectory}/Automatic sync.md`, localFile = path.join(config.folder, relative);
const localText = '# Automatic sync test\n\nSynthetic local-to-cloud verification.\n';
const remoteText = '# Automatic sync test\n\nSynthetic cloud-to-local verification.\n';
let head: FileRecord | undefined, deleted = false, installed = false, finalScheduleRestored = false;
const measurements: Record<string, number | boolean | string> = {};

async function api(endpoint: string, body?: FileWrite) {
  const response = await fetch(`${pairing.server}/api/vaults/${pairing.vaultId}/${endpoint}`, { method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${pairing.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Synthetic verification API failed (${response.status})`);
  return response.json();
}
async function current(): Promise<FileRecord | undefined> {
  if (head) return (await api(`files/${head.id}`)).file;
  let cursor = 0;
  for (;;) {
    const page = await api(`manifests?after=${cursor}`) as { files: FileManifest[]; cursor: number; hasMore: boolean };
    for (const manifest of page.files) {
      if (manifest.deleted || !manifest.manifestBox) continue;
      if ((await decryptManifest(manifest, pairing.keyring)).path === relative) return (await api(`files/${manifest.id}`)).file;
    }
    if (!page.hasMore) return undefined; cursor = page.cursor;
  }
}
async function writeRemote(content: string, remove = false) {
  if (!head) throw new Error('Synthetic note has no remote revision');
  const data = { path: relative, content }, revision = head.revision + 1;
  const write: FileWrite = { id: head.id, baseRevision: head.revision, epoch: pairing.keyring.currentEpoch, deleted: remove, mutationId: randomUUID(), box: await encryptFile(pairing.vaultId, head.id, revision, remove, data, pairing.keyring), manifestBox: await encryptManifest(pairing.vaultId, head.id, revision, remove, data, pairing.keyring) };
  head = (await api(`files/${head.id}`, write)).file;
}
async function poll(label: string, timeout: number, check: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) { measurements[label] = Date.now() - start; console.log(JSON.stringify({ phase: label, elapsedMs: measurements[label] })); return; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out verifying ${label}; no original notes were edited`);
}
async function install(minutes: number) {
  await exec(process.execPath, [path.join(project, 'dist-bridge/cli.js'), 'install', '--profile', profile, '--mode', 'change', '--interval', String(minutes)], { cwd: project, timeout: 30_000 });
}
async function originalHashesUnchanged() {
  for (const file of checkpoint.selectedFiles) {
    const data = await fs.readFile(path.join(config.folder, file.path));
    if (createHash('sha256').update(data).digest('hex') !== file.hash) throw new Error('An original selected file changed during live verification');
  }
}
try {
  await originalHashesUnchanged();
  await install(1); installed = true;
  await fs.mkdir(path.dirname(localFile), { recursive: false, mode: 0o700 }); await fs.writeFile(localFile, localText, { mode: 0o600, flag: 'wx' });
  await poll('automatic-local-to-cloud', 90_000, async () => { const record = await current(); if (!record || record.deleted) return false; if ((await decryptFile(record, pairing.keyring)).content !== localText) return false; head = record; return true; });
  await writeRemote(remoteText);
  await poll('automatic-cloud-to-local', 100_000, async () => { try { return await fs.readFile(localFile, 'utf8') === remoteText; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } });
  await fs.unlink(localFile);
  await poll('automatic-local-delete-to-cloud', 90_000, async () => { const record = await current(); if (record?.deleted) { head = record; deleted = true; return true; } return false; });
  await fs.rmdir(path.dirname(localFile));
  await install(5); finalScheduleRestored = true;
  await poll('background-idle-after-restoring-five-minutes', 30_000, async () => { const state = await readState(stateDir); return state.pending.length === 0 && !state.lastError && !!state.lastSuccess; });
  await originalHashesUnchanged();
  const result = await exec('launchctl', ['print', `gui/${process.getuid!()}/app.flint.bridge.${profile}`], { timeout: 10_000 });
  if (!/state = running/.test(result.stdout)) throw new Error('LaunchAgent is installed but not running');
  const proof = { verifiedAt: new Date().toISOString(), server: pairing.server, vaultId: pairing.vaultId, profile, mode: 'change', finalIntervalMinutes: 5, testIntervalMinutes: 1, automaticLocalToCloud: true, automaticCloudToLocal: true, automaticDeletion: true, syntheticFileRemoved: deleted, originalFiles: checkpoint.selectedFiles.length, originalHashesUnchanged: true, launchAgentRunning: true, pending: (await readState(stateDir)).pending.length, measurements };
  await atomicJson(path.join(checkpoint.backup, 'automatic-sync-verification.json'), proof);
  console.log(JSON.stringify({ phase: 'automatic-sync-verified', ...proof }));
} finally {
  if (!deleted) {
    // Recover only this unique synthetic test artifact; never touch any original note.
    try { await fs.unlink(localFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { const record = await current(); if (record && !record.deleted) { head = record; await writeRemote('', true); } } catch { /* Preserve the unique synthetic artifact if the service is unavailable. */ }
    try { await fs.rmdir(path.dirname(localFile)); } catch { /* Leave a nonempty directory intact. */ }
  }
  if (installed && !finalScheduleRestored) await install(5);
}
