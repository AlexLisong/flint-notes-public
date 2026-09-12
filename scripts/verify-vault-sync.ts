/**
 * Private first-sync checkpoint. Default: backup/inventory only, no network or vault writes.
 *   node --import tsx scripts/verify-vault-sync.ts --folder /path/to/vault --backup-only
 * After deployment is ready, explicitly:
 *   node --import tsx scripts/verify-vault-sync.ts --folder /path/to/vault --sync --pairing-file .data/aws/pairing.json
 * Credentials/note bodies are never printed. Full backup, hashes and child logs stay in .data.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { atomicJson, CHUNK_SIZE, MAX_FILE_SIZE, scanFolder, selected, safeRelativePath, type BridgeConfig, type Pairing } from '../bridge/engine';
import { validatePairing } from '../bridge/secrets';
import { decryptChunk, decryptFile, decryptManifest } from '../shared/crypto';
import type { FileManifest, FileRecord } from '../shared/types';

const runFile = promisify(execFile);
const args = process.argv.slice(2);
function arg(name: string, fallback?: string) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folderArgument = arg('--folder');
if (!folderArgument) throw new Error('Supply --folder with the vault you intend to back up or synchronize.');
const folder = await fs.realpath(path.resolve(folderArgument));
const backupRoot = path.resolve(arg('--backup-root', path.join(projectRoot, '.data/vault-backup'))!);
const profile = arg('--profile', 'personal')!;
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(profile)) throw new Error('Invalid companion profile');
const relativeBackup = path.relative(folder, backupRoot);
if (!relativeBackup || !relativeBackup.startsWith('..' + path.sep) && relativeBackup !== '..' && !path.isAbsolute(relativeBackup)) throw new Error('Backup storage must be outside the source vault');
interface Entry { path: string; hash: string; bytes: number }
interface Inventory { version: 1; createdAt: string; folder: string; backup: string; selectedFiles: Entry[]; selectedBytes: number; copiedFiles: number; copiedBytes: number }
function config(vaultFolder: string): BridgeConfig { return { server: 'http://127.0.0.1', vaultId: 'inventory-only', folder: vaultFolder, stateDir: backupRoot, obsidianSettings: false }; }
async function inventory(vaultFolder: string): Promise<Entry[]> {
  const scanned = await scanFolder(config(vaultFolder));
  return [...scanned.values()].map(file => ({ path: file.path, hash: file.hash, bytes: file.bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
}
function sameFiles(expected: Entry[], actual: Entry[], exact = true) {
  const byPath = new Map(actual.map(file => [file.path, file]));
  return (!exact || expected.length === actual.length) && expected.every(file => byPath.get(file.path)?.hash === file.hash && byPath.get(file.path)?.bytes === file.bytes);
}
async function restrictTree(directory: string): Promise<{ files: number; bytes: number }> {
  await fs.chmod(directory, 0o700); let files = 0, bytes = 0;
  for (const name of await fs.readdir(directory)) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) continue; // Never chmod through a copied symlink.
    if (stat.isDirectory()) { const child = await restrictTree(file); files += child.files; bytes += child.bytes; }
    else if (stat.isFile()) { await fs.chmod(file, 0o600); files++; bytes += stat.size; }
    else throw new Error('A special filesystem object prevents a complete private backup');
  }
  return { files, bytes };
}
async function backup(): Promise<Inventory> {
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 }); await fs.chmod(backupRoot, 0o700);
  const selectedFiles = await inventory(folder), createdAt = new Date().toISOString();
  const destination = path.join(backupRoot, createdAt.replace(/[:.]/g, '-'));
  await fs.mkdir(destination, { mode: 0o700 });
  const copiedVault = path.join(destination, 'vault');
  await fs.cp(folder, copiedVault, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
  const copied = await restrictTree(copiedVault);
  const [copiedFiles, sourceAfter] = await Promise.all([inventory(copiedVault), inventory(folder)]);
  if (!sameFiles(selectedFiles, copiedFiles) || !sameFiles(selectedFiles, sourceAfter)) throw new Error('Source vault changed during backup or backup verification failed. Original files were not modified; repeat backup before first sync.');
  const result: Inventory = { version: 1, createdAt, folder, backup: destination, selectedFiles, selectedBytes: selectedFiles.reduce((sum, file) => sum + file.bytes, 0), copiedFiles: copied.files, copiedBytes: copied.bytes };
  await atomicJson(path.join(destination, 'inventory.json'), result);
  await atomicJson(path.join(backupRoot, 'latest.json'), { backup: destination, folder, createdAt });
  console.log(JSON.stringify({ phase: 'private-backup', backup: destination, selectedFiles: selectedFiles.length, selectedBytes: result.selectedBytes, copiedFiles: copied.files, copiedBytes: copied.bytes, sourceUnchanged: true, synced: false }));
  return result;
}
async function loadCheckpoint(): Promise<Inventory> {
  const destination = arg('--backup') || JSON.parse(await fs.readFile(path.join(backupRoot, 'latest.json'), 'utf8')).backup;
  const checkpoint = JSON.parse(await fs.readFile(path.join(destination, 'inventory.json'), 'utf8')) as Inventory;
  if (checkpoint.version !== 1 || checkpoint.folder !== folder || checkpoint.backup !== destination || !Array.isArray(checkpoint.selectedFiles)) throw new Error('Backup checkpoint belongs to another folder or is invalid');
  const copied = await inventory(path.join(destination, 'vault'));
  if (!sameFiles(checkpoint.selectedFiles, copied)) throw new Error('The private backup no longer matches its recorded inventory');
  return checkpoint;
}
async function request(pairing: Pairing, endpoint: string): Promise<Response> {
  const response = await fetch(`${pairing.server}/api/vaults/${pairing.vaultId}/${endpoint}`, { headers: { Authorization: `Bearer ${pairing.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Remote verification request failed (${response.status}); no private response body was logged`);
  return response;
}
async function remoteInventory(pairing: Pairing): Promise<Entry[]> {
  let cursor = 0; const result = new Map<string, Entry>();
  for (;;) {
    const page = await (await request(pairing, `manifests?after=${cursor}`)).json() as { files: FileManifest[]; cursor: number; hasMore: boolean };
    if (!Array.isArray(page.files) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor || page.hasMore && page.cursor === cursor) throw new Error('Invalid remote verification cursor');
    for (const manifest of page.files) {
      if (manifest.deleted) continue;
      const metadata = manifest.manifestBox ? await decryptManifest(manifest, pairing.keyring) : undefined;
      if (metadata && !selected(safeRelativePath(metadata.path), config(folder))) continue;
      const { file } = await (await request(pairing, `files/${manifest.id}?revision=${manifest.revision}`)).json() as { file: FileRecord };
      if (file.id !== manifest.id || file.vaultId !== pairing.vaultId || file.revision !== manifest.revision || file.epoch !== manifest.epoch || file.deleted) throw new Error('Remote selected revision changed unexpectedly');
      const data = await decryptFile(file, pairing.keyring), relative = safeRelativePath(data.path);
      if (metadata && (metadata.path !== data.path || !!metadata.attachment !== !!data.attachment || metadata.attachment && (metadata.attachment.mime !== data.attachment?.mime || metadata.attachment.size !== data.attachment?.size))) throw new Error('Remote manifest and encrypted body disagree');
      if (!selected(relative, config(folder))) continue;
      if (result.has(relative)) throw new Error('Remote verification found duplicate selected paths');
      const digest = createHash('sha256'); let bytes = 0;
      if (data.attachment) {
        for (const chunkId of data.attachment.chunks) {
          const encrypted = new Uint8Array(await (await request(pairing, `chunks/${chunkId}`)).arrayBuffer());
          if (encrypted.length > 2 * CHUNK_SIZE) throw new Error('Remote encrypted chunk exceeds the verification limit');
          const decrypted = await decryptChunk(pairing.vaultId, chunkId, encrypted, pairing.keyring, data.attachment.epoch);
          digest.update(decrypted); bytes += decrypted.length;
          if (bytes > MAX_FILE_SIZE || bytes > data.attachment.size) throw new Error('Remote attachment size verification failed');
        }
        if (bytes !== data.attachment.size) throw new Error('Remote attachment is incomplete');
      } else {
        const plaintext = new TextEncoder().encode(data.content); bytes = plaintext.length; digest.update(plaintext);
      }
      result.set(relative, { path: relative, hash: digest.digest('hex'), bytes });
    }
    cursor = page.cursor; if (!page.hasMore) break;
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}
async function syncAndVerify() {
  const checkpoint = await loadCheckpoint(), before = await inventory(folder);
  if (!sameFiles(checkpoint.selectedFiles, before)) throw new Error('Original selected files changed since the backup. Create a fresh checkpoint before first sync.');
  const pairingFile = path.resolve(arg('--pairing-file', path.join(projectRoot, '.data/aws/pairing.json'))!);
  const pairingStat = await fs.stat(pairingFile);
  if ((pairingStat.mode & 0o077) !== 0) throw new Error('Pairing credential file must have mode 0600');
  const pairing = validatePairing(JSON.parse(await fs.readFile(pairingFile, 'utf8')));
  const cli = path.join(projectRoot, 'dist-bridge/cli.js'); await fs.access(cli);
  const childLog: { command: string; stdout?: string; stderr?: string }[] = [];
  for (const command of [['pair', '--profile', profile, '--pairing-file', pairingFile, '--folder', folder], ['once', '--profile', profile]]) {
    try {
      const output = await runFile(process.execPath, [cli, ...command], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024, timeout: 15 * 60_000 });
      childLog.push({ command: command[0], stdout: output.stdout, stderr: output.stderr });
    } catch (error) {
      const child = error as Error & { stdout?: string; stderr?: string };
      childLog.push({ command: command[0], stdout: child.stdout, stderr: child.stderr });
      await atomicJson(path.join(checkpoint.backup, 'sync-command-log.json'), childLog);
      throw new Error(`Companion ${command[0]} failed. Restricted diagnostics are stored beside the private backup; original contents were not printed.`);
    }
  }
  await atomicJson(path.join(checkpoint.backup, 'sync-command-log.json'), childLog);
  const after = await inventory(folder);
  if (!sameFiles(checkpoint.selectedFiles, after, false)) throw new Error('An original selected file hash changed during first sync. Stop background enrollment and review the preserved private backup.');
  const remote = await remoteInventory(pairing);
  if (!sameFiles(after, remote)) throw new Error('Decrypted remote file hashes/counts do not match the selected local vault. Background enrollment has not been performed by this script.');
  const proof = { verifiedAt: new Date().toISOString(), server: pairing.server, vaultId: pairing.vaultId, profile, folder, backup: checkpoint.backup, originalFiles: checkpoint.selectedFiles.length, originalBytes: checkpoint.selectedBytes, localFiles: after.length, localBytes: after.reduce((sum, file) => sum + file.bytes, 0), remoteFiles: remote.length, remoteBytes: remote.reduce((sum, file) => sum + file.bytes, 0), originalHashesUnchanged: true, decryptedRemoteHashesMatch: true, backgroundInstalled: false };
  await atomicJson(path.join(checkpoint.backup, 'first-sync-verification.json'), proof);
  console.log(JSON.stringify({ phase: 'private-first-sync-verified', ...proof }));
}
if (args.includes('--sync') && args.includes('--backup-only')) throw new Error('Choose --backup-only or --sync, not both');
if (args.includes('--sync')) await syncAndVerify(); else await backup();
