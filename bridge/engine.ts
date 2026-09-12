import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { decryptChunk, decryptFile, decryptManifest, encryptChunk, encryptFile, encryptManifest, type Keyring, type ManifestData } from '../shared/crypto';
import type { FileData, FileManifest, FileRecord, FileWrite } from '../shared/types';

export const CHUNK_SIZE = 1024 * 1024;
export const MAX_FILE_SIZE = 200 * 1024 * 1024;
const textExtensions = new Set(['.md', '.markdown', '.txt', '.canvas', '.base', '.json', '.yaml', '.yml', '.css', '.csv', '.tsv']);
export interface BridgeConfig { server: string; vaultId: string; folder: string; stateDir: string; excludes?: string[]; extensions?: string[]; obsidianSettings?: boolean }
export interface Pairing { server: string; vaultId: string; token: string; keyring: Keyring }
export interface Baseline { id: string; path: string; remotePath: string; revision: number; hash: string; deleted: boolean; selected: boolean }
interface Pending { write: FileWrite; path: string; hash: string; chunks: string[] }
export interface BridgeState { version: 1; cursor: number; files: Record<string, Baseline>; pending: Pending[]; folderIdentity?: { device: string; inode: string }; lastSuccess?: string; lastAttempt?: string; lastError?: string }
interface DiskFile { path: string; hash: string; bytes: Uint8Array }
export class RotationRequiredError extends Error { constructor() { super('Vault encryption changed. Pause sync and pair this device again with a fresh pairing file. Local changes are preserved.'); } }
export class ApiError extends Error { constructor(public status: number, public body: { error?: string; file?: FileRecord } = {}) { super(body.error || `Flint API returned ${status}`); } }
export const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function safeRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Unsafe vault file path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) throw new Error('Unsafe vault file path');
  if (parts[0] === '.git' || parts[0] === '.flint') throw new Error('Reserved vault file path');
  return parts.join('/');
}
export function selected(relative: string, config: BridgeConfig): boolean {
  const parts = relative.split('/');
  if (parts.some((part, index) => part.startsWith('.') && !(index === 0 && part === '.obsidian' && config.obsidianSettings))) return false;
  if (parts.some(part => part === '.git' || part === '.flint' || part === '.DS_Store' || part.startsWith('.flint-tmp-') || part.endsWith('.swp') || part.endsWith('.tmp') || part.endsWith('~'))) return false;
  if (relative.startsWith('.obsidian/')) {
    if (!config.obsidianSettings) return false;
    if (!/^\.obsidian\/(?:[^/]+\.json|snippets\/[^/]+\.css|plugins\/[^/]+\/data\.json)$/.test(relative)) return false;
  }
  if ((config.excludes || []).some(exclude => relative === exclude.replace(/\/$/, '') || relative.startsWith(exclude.replace(/\/$/, '') + '/'))) return false;
  if (config.extensions?.length && !relative.startsWith('.obsidian/') && !config.extensions.map(extension => extension.startsWith('.') ? extension.toLowerCase() : '.' + extension.toLowerCase()).includes(path.posix.extname(relative).toLowerCase())) return false;
  return true;
}
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
}
export async function readState(stateDir: string): Promise<BridgeState> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8')) as BridgeState;
    if (state.version !== 1 || !Array.isArray(state.pending) || !state.files || !Number.isSafeInteger(state.cursor)) throw new Error('Invalid bridge state. Preserve this directory and repair or create a new profile.');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cursor: 0, files: {}, pending: [] };
    throw error;
  }
}
async function exists(file: string) { try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function checkedPath(folder: string, relative: string, createParents = false): Promise<string> {
  const clean = safeRelativePath(relative), parts = clean.split('/');
  const root = await fs.lstat(folder);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('The paired vault folder is missing, changed, or a symlink');
  let cursor = folder;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Sync will not follow a symlink: ${clean}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`A file blocks the vault directory: ${clean}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && index < parts.length - 1) await fs.mkdir(cursor, { mode: 0o700 });
    }
  }
  return cursor;
}
async function diskRead(folder: string, relative: string): Promise<DiskFile | undefined> {
  const file = await checkedPath(folder, relative);
  try {
    const before = await fs.stat(file);
    if (!before.isFile()) throw new Error(`Expected a regular file: ${relative}`);
    if (before.size > MAX_FILE_SIZE) throw new Error(`File exceeds the 200 MiB companion limit: ${relative}`);
    const bytes = new Uint8Array(await fs.readFile(file)), after = await fs.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error(`File changed during sync; it will retry: ${relative}`);
    return { path: relative, hash: hashBytes(bytes), bytes };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function scanFolder(config: BridgeConfig): Promise<Map<string, DiskFile>> {
  const result = new Map<string, DiskFile>(), folded = new Set<string>();
  const root = await fs.lstat(config.folder);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The paired vault folder is unavailable');
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && !(prefix === '' && entry.name === '.obsidian' && config.obsidianSettings) || (config.excludes || []).some(exclude => relative === exclude.replace(/\/$/, ''))) continue;
        await visit(await checkedPath(config.folder, relative), relative + '/');
      } else if (selected(relative, config)) {
        safeRelativePath(relative);
        if (entry.isSymbolicLink()) throw new Error(`Sync will not follow a symlink: ${relative}`);
        if (!entry.isFile()) continue;
        const fold = relative.normalize('NFC').toLowerCase();
        if (folded.has(fold)) throw new Error(`Case/Unicode-equivalent filenames need distinct names before sync: ${relative}`);
        folded.add(fold);
        const file = await diskRead(config.folder, relative);
        if (!file) throw new Error(`Folder changed during scan; retrying later: ${relative}`);
        result.set(relative, file);
      }
    }
  };
  await visit(config.folder, '');
  return result;
}
function mime(relative: string) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' } as Record<string, string>)[path.posix.extname(relative).toLowerCase()] || 'application/octet-stream';
}

/** One serialized client; state survives interruption after any API request. */
export class BridgeEngine {
  private state!: BridgeState;
  private active = false;
  constructor(readonly config: BridgeConfig, readonly pairing: Pairing, private log: (message: string) => void = () => {}) {
    if (config.vaultId !== pairing.vaultId || new URL(config.server).origin !== new URL(pairing.server).origin) throw new Error('Pairing credentials do not match this server/vault');
    const stateRelative = path.relative(path.resolve(config.folder), path.resolve(config.stateDir));
    if (!stateRelative || !stateRelative.startsWith('..' + path.sep) && stateRelative !== '..' && !path.isAbsolute(stateRelative)) throw new Error('Companion state must be outside the synced folder');
  }
  private async request(endpoint: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${this.pairing.token}`);
    const response = await fetch(new URL(endpoint, this.config.server), { ...init, headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) {
      if (response.status === 412) throw new RotationRequiredError();
      let body = {}; try { body = await response.json(); } catch { /* retain safe status error */ }
      throw new ApiError(response.status, body);
    }
    return response;
  }
  private route(suffix: string) { return `/api/vaults/${encodeURIComponent(this.config.vaultId)}/${suffix}`; }
  private persist() { return atomicJson(path.join(this.config.stateDir, 'state.json'), this.state); }
  private async chunkFile(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid chunk identifier');
    const directory = path.join(this.config.stateDir, 'uploads'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, id);
  }
  private async localBytes(data: FileData, localChunks = false): Promise<Uint8Array> {
    if (!data.attachment) return new TextEncoder().encode(data.content);
    const attachment = data.attachment;
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_FILE_SIZE || attachment.chunks.length > Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE)) throw new Error('Invalid or oversized attachment');
    const all = new Uint8Array(attachment.size); let offset = 0;
    for (const id of attachment.chunks) {
      const encrypted = localChunks ? new Uint8Array(await fs.readFile(await this.chunkFile(id))) : new Uint8Array(await (await this.request(this.route(`chunks/${encodeURIComponent(id)}`))).arrayBuffer());
      if (encrypted.length > 2 * CHUNK_SIZE) throw new Error('Oversized encrypted chunk');
      const bytes = await decryptChunk(this.config.vaultId, id, encrypted, this.pairing.keyring, attachment.epoch);
      if (offset + bytes.length > all.length) throw new Error('Attachment size does not match manifest');
      all.set(bytes, offset); offset += bytes.length;
    }
    if (offset !== all.length) throw new Error('Attachment is incomplete');
    return all;
  }
  private async conflictPath(relative: string): Promise<string> {
    const extension = path.posix.extname(relative), base = extension ? relative.slice(0, -extension.length) : relative;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = `${base} (conflict ${new Date().toISOString().replace(/[:.]/g, '-')} ${randomUUID().slice(0, 6)})${extension}`;
      if (!await exists(await checkedPath(this.config.folder, candidate))) return candidate;
    }
    throw new Error('Could not allocate a conflict filename');
  }
  private async preserve(relative: string) {
    const current = await diskRead(this.config.folder, relative);
    if (!current) return;
    const conflict = await this.conflictPath(relative);
    await fs.rename(await checkedPath(this.config.folder, relative), await checkedPath(this.config.folder, conflict, true));
    this.log(`Preserved a conflicting edit: ${conflict}`);
  }
  private async writeDisk(relative: string, bytes: Uint8Array, expectedHash?: string) {
    const target = await checkedPath(this.config.folder, relative, true);
    const temporary = path.join(path.dirname(target), `.flint-tmp-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await checkedPath(this.config.folder, relative, true);
      const current = await diskRead(this.config.folder, relative);
      if (current && current.hash !== expectedHash && current.hash !== hashBytes(bytes)) await this.preserve(relative);
      await fs.rename(temporary, target);
    }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
  private async applyRemote(record: FileRecord) {
    if (record.vaultId !== this.config.vaultId) throw new Error('Remote file belongs to another vault');
    const prior = this.state.files[record.id];
    if (prior && prior.revision >= record.revision && prior.selected === selected(prior.remotePath, this.config)) return;
    const data = await decryptFile(record, this.pairing.keyring), remotePath = safeRelativePath(data.path), included = selected(remotePath, this.config);
    if (record.manifestBox) this.assertManifestMatches(await decryptManifest(record, this.pairing.keyring), data);
    if (!included) {
      await this.excludeRemote(record, remotePath); return;
    }
    let localPath = remotePath;
    const occupant = Object.values(this.state.files).find(file => file.id !== record.id && !file.deleted && file.selected && file.path.normalize('NFC').toLowerCase() === remotePath.normalize('NFC').toLowerCase());
    if (occupant && !record.deleted) localPath = await this.conflictPath(remotePath);
    const old = prior && !prior.deleted && prior.hash ? await diskRead(this.config.folder, prior.path) : undefined;
    if (record.deleted) {
      if (old && prior) {
        if (old.hash !== prior.hash) await this.preserve(prior.path);
        else await fs.unlink(await checkedPath(this.config.folder, prior.path));
      }
      this.state.files[record.id] = { id: record.id, path: prior?.path || remotePath, remotePath, revision: record.revision, hash: '', deleted: true, selected: true };
      await this.persist(); return;
    }
    const bytes = await this.localBytes(data), incomingHash = hashBytes(bytes);
    // Preserve unsent local edits before applying a remote write or rename.
    if (old && prior && old.hash !== prior.hash && old.hash !== incomingHash) await this.preserve(prior.path);
    const existing = await diskRead(this.config.folder, localPath);
    if (existing && existing.hash !== incomingHash) {
      if (!(prior && localPath === prior.path && existing.hash === prior.hash)) await this.preserve(localPath);
    }
    if (!existing || existing.hash !== incomingHash) await this.writeDisk(localPath, bytes, existing?.hash);
    if (prior && prior.path !== localPath) {
      const previous = await diskRead(this.config.folder, prior.path);
      if (previous) {
        const oldPath = await checkedPath(this.config.folder, prior.path), newPath = await checkedPath(this.config.folder, localPath);
        const oldStat = await fs.stat(oldPath), newStat = await fs.stat(newPath);
        if (oldStat.dev === newStat.dev && oldStat.ino === newStat.ino) {
          // Case-only/Unicode-equivalent rename on a case-insensitive filesystem.
          const intermediate = path.join(path.dirname(oldPath), `.flint-tmp-${randomUUID()}`);
          await fs.rename(oldPath, intermediate); await fs.rename(intermediate, newPath);
        } else if (previous.hash === prior.hash) await fs.unlink(oldPath);
      }
    }
    this.state.files[record.id] = { id: record.id, path: localPath, remotePath, revision: record.revision, hash: incomingHash, deleted: false, selected: true };
    await this.persist();
  }
  private assertManifestMatches(manifest: ManifestData, data: FileData) {
    if (manifest.path !== data.path || !!manifest.attachment !== !!data.attachment || manifest.attachment && (manifest.attachment.mime !== data.attachment?.mime || manifest.attachment.size !== data.attachment?.size)) throw new Error('Encrypted file body does not match its selected manifest');
  }
  private async excludeRemote(record: FileManifest, remotePath: string) {
    const prior = this.state.files[record.id];
    this.state.files[record.id] = { id: record.id, path: prior?.path || remotePath, remotePath, revision: record.revision, hash: prior?.hash || '', deleted: record.deleted, selected: false };
    await this.persist();
  }
  private async rekeyPending(pending: Pending) {
    if (pending.write.epoch === this.pairing.keyring.currentEpoch) return;
    const data = await decryptFile({ ...pending.write, vaultId: this.config.vaultId, revision: pending.write.baseRevision + 1, updatedAt: '', seq: 0 }, this.pairing.keyring);
    const previousChunks = [...pending.chunks];
    if (data.attachment && pending.chunks.length) {
      const bytes = await this.localBytes(data, true), prepared = await this.prepareData({ path: data.path, hash: pending.hash, bytes });
      data.attachment = prepared.data.attachment; pending.chunks = prepared.chunks;
    }
    pending.write = { ...pending.write, mutationId: randomUUID(), epoch: this.pairing.keyring.currentEpoch, box: await encryptFile(this.config.vaultId, pending.write.id, pending.write.baseRevision + 1, pending.write.deleted, data, this.pairing.keyring), manifestBox: await encryptManifest(this.config.vaultId, pending.write.id, pending.write.baseRevision + 1, pending.write.deleted, data, this.pairing.keyring) };
    await this.persist();
    for (const id of previousChunks) if (!pending.chunks.includes(id)) await fs.rm(await this.chunkFile(id), { force: true });
  }
  private async flushPending() {
    while (this.state.pending.length) {
      const pending = this.state.pending[0]; await this.rekeyPending(pending);
      try {
        for (const id of pending.chunks) {
          const bytes = await fs.readFile(await this.chunkFile(id));
          await this.request(this.route(`chunks/${id}`), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
        }
        const response = await this.request(this.route(`files/${pending.write.id}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.write) });
        const { file } = await response.json() as { file: FileRecord };
        this.state.files[file.id] = { id: file.id, path: pending.path, remotePath: pending.path, hash: pending.hash, revision: file.revision, deleted: file.deleted, selected: true };
        this.state.pending.shift(); await this.persist();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !error.body.file) throw error;
        if (!pending.write.deleted) {
          const data = await decryptFile({ ...pending.write, vaultId: this.config.vaultId, revision: pending.write.baseRevision + 1, seq: 0, updatedAt: '' }, this.pairing.keyring);
          const destination = await this.conflictPath(pending.path);
          await this.writeDisk(destination, await this.localBytes(data, pending.chunks.length > 0));
          this.log(`Preserved an upload conflict: ${destination}`);
          const prior = this.state.files[pending.write.id], current = await diskRead(this.config.folder, pending.path);
          if (prior && current?.hash === pending.hash) prior.hash = pending.hash;
        } else {
          this.log(`Kept a newer remote file after a conflicting local deletion: ${pending.path}`);
        }
        this.state.pending.shift(); await this.persist();
        await this.applyRemote(error.body.file);
      }
      for (const id of pending.chunks) await fs.rm(await this.chunkFile(id), { force: true });
    }
  }
  private async pull() {
    for (;;) {
      const page = await (await this.request(this.route(`manifests?after=${this.state.cursor}`))).json() as { files: FileManifest[]; cursor: number; hasMore: boolean };
      if (!Array.isArray(page.files) || !Number.isSafeInteger(page.cursor) || page.cursor < this.state.cursor || page.hasMore && page.cursor === this.state.cursor) throw new Error('Invalid sync cursor response');
      for (const header of page.files) {
        if (header.vaultId !== this.config.vaultId) throw new Error('Remote manifest belongs to another vault');
        const manifest = header.manifestBox ? await decryptManifest(header, this.pairing.keyring) : undefined;
        if (manifest && !selected(safeRelativePath(manifest.path), this.config)) { await this.excludeRemote(header, manifest.path); continue; }
        const prior = this.state.files[header.id];
        if (prior && prior.selected && prior.revision >= header.revision) continue;
        const { file } = await (await this.request(this.route(`files/${encodeURIComponent(header.id)}?revision=${header.revision}`))).json() as { file: FileRecord };
        if (file.id !== header.id || file.vaultId !== header.vaultId || file.revision !== header.revision || file.epoch !== header.epoch || file.deleted !== header.deleted) throw new Error('File response does not match the selected manifest revision');
        if (manifest) this.assertManifestMatches(manifest, await decryptFile(file, this.pairing.keyring));
        await this.applyRemote(file);
      }
      this.state.cursor = page.cursor; await this.persist();
      if (!page.hasMore) return;
    }
  }
  private async prepareData(disk: DiskFile): Promise<{ data: FileData; chunks: string[] }> {
    if (textExtensions.has(path.posix.extname(disk.path).toLowerCase()) && disk.bytes.length <= CHUNK_SIZE) {
      try {
        const data = { path: disk.path, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(disk.bytes) };
        if (new TextEncoder().encode(JSON.stringify(data)).length < 1_400_000) return { data, chunks: [] };
      } catch { /* binary or non-UTF8: preserve exact bytes in chunks */ }
    }
    const chunks: string[] = [];
    for (let offset = 0; offset < disk.bytes.length; offset += CHUNK_SIZE) {
      const id = randomUUID(), encrypted = await encryptChunk(this.config.vaultId, id, disk.bytes.subarray(offset, offset + CHUNK_SIZE), this.pairing.keyring);
      await fs.writeFile(await this.chunkFile(id), encrypted, { mode: 0o600, flag: 'wx' }); chunks.push(id);
    }
    return { data: { path: disk.path, content: '', attachment: { mime: mime(disk.path), size: disk.bytes.length, chunks, epoch: this.pairing.keyring.currentEpoch } }, chunks };
  }
  private async queue(disk: DiskFile | undefined, baseline?: Baseline) {
    const id = baseline?.id || randomUUID(), relative = disk?.path || baseline!.path;
    const prepared = disk ? await this.prepareData(disk) : { data: { path: relative, content: '' }, chunks: [] };
    const baseRevision = baseline?.revision || 0, deleted = !disk;
    const write: FileWrite = { id, baseRevision, epoch: this.pairing.keyring.currentEpoch, deleted, mutationId: randomUUID(), box: await encryptFile(this.config.vaultId, id, baseRevision + 1, deleted, prepared.data, this.pairing.keyring), manifestBox: await encryptManifest(this.config.vaultId, id, baseRevision + 1, deleted, prepared.data, this.pairing.keyring) };
    this.state.pending.push({ write, path: relative, hash: disk?.hash || '', chunks: prepared.chunks }); await this.persist();
  }
  private async pushLocal() {
    // Finish a complete readable scan before inferring any deletion.
    const disk = await scanFolder(this.config), consumed = new Set<string>(Object.values(this.state.files).filter(file => !file.selected && file.hash).map(file => file.path));
    const baselines = Object.values(this.state.files).filter(file => file.selected && selected(file.path, this.config));
    const knownPaths = new Set(baselines.filter(file => !file.deleted).map(file => file.path));
    const renamed = new Set<string>();
    // A unique unchanged-content move is a rename, keeping the remote file ID/history.
    for (const baseline of baselines.filter(file => !file.deleted && !disk.has(file.path))) {
      const candidates = [...disk.values()].filter(file => !knownPaths.has(file.path) && !consumed.has(file.path) && file.hash === baseline.hash);
      const equivalentMissing = baselines.filter(file => !file.deleted && !disk.has(file.path) && file.hash === baseline.hash);
      if (candidates.length === 1 && equivalentMissing.length === 1) {
        await this.queue(candidates[0], baseline); consumed.add(candidates[0].path); renamed.add(baseline.id);
      }
    }
    for (const baseline of baselines) {
      if (baseline.deleted || renamed.has(baseline.id)) continue;
      const local = disk.get(baseline.path); if (local) consumed.add(local.path);
      if (!local || local.hash !== baseline.hash || baseline.path !== baseline.remotePath) await this.queue(local, baseline);
    }
    for (const local of disk.values()) if (!consumed.has(local.path)) await this.queue(local);
    await this.flushPending();
  }
  async syncOnce(): Promise<BridgeState> {
    if (this.active) throw new Error('A sync cycle is already running');
    this.active = true;
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.config.stateDir, 'sync.lock'); let acquired = false;
    try {
      try { await fs.mkdir(lockPath); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid = 0; try { pid = Number(await fs.readFile(path.join(lockPath, 'pid'), 'utf8')); } catch { /* newly created or interrupted lock */ }
        let alive = true;
        if (pid <= 0 && Date.now() - (await fs.stat(lockPath)).mtimeMs > 60_000) alive = false;
        try { if (pid > 0) process.kill(pid, 0); } catch (check) { if ((check as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another companion process is syncing this profile');
        await fs.rm(lockPath, { recursive: true }); await fs.mkdir(lockPath); acquired = true;
      }
      await fs.writeFile(path.join(lockPath, 'pid'), String(process.pid), { mode: 0o600 });
      this.state = await readState(this.config.stateDir); this.state.lastAttempt = new Date().toISOString(); await this.persist();
      // A missing/moved folder must never turn into remote deletions.
      const root = await fs.lstat(this.config.folder); if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Paired folder is unavailable');
      const identity = { device: String(root.dev), inode: String(root.ino) };
      if (this.state.folderIdentity && (this.state.folderIdentity.device !== identity.device || this.state.folderIdentity.inode !== identity.inode)) throw new Error('The paired folder was replaced or remounted. Use a new profile to review a fresh merge; no deletions were sent.');
      this.state.folderIdentity = identity; await this.persist();
      // Preflight the entire selected tree before any queued upload or remote disk write.
      await scanFolder(this.config);
      await this.flushPending(); await this.pull(); await this.pushLocal();
      this.state.lastSuccess = new Date().toISOString(); delete this.state.lastError; await this.persist();
      this.log(`Synced ${Object.values(this.state.files).filter(file => !file.deleted && file.selected).length} files`);
      return this.state;
    } catch (error) {
      if (this.state && acquired) { this.state.lastError = (error as Error).message; await this.persist(); }
      throw error;
    } finally { if (acquired) await fs.rm(lockPath, { recursive: true, force: true }); this.active = false; }
  }
}
