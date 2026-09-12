#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import chokidar from 'chokidar';
import { decryptFile, decryptManifest } from '../shared/crypto';
import type { FileManifest, FileRecord } from '../shared/types';
import { ApiError, BridgeEngine, RotationRequiredError, atomicJson, readState, type BridgeConfig, type Pairing } from './engine';
import { loadPairing, savePairing, validatePairing } from './secrets';

interface SavedConfig extends BridgeConfig { allowFileSecrets?: boolean; interval: number; mode: 'interval' | 'change' }
const args = process.argv.slice(2), command = args.shift() || 'help';
const flags = new Map<string, string>();
for (let index = 0; index < args.length; index++) {
  const key = args[index]; if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
  flags.set(key.slice(2), args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : 'true');
}
const profile = flags.get('profile') || 'default';
if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(profile)) throw new Error('Profile must contain lowercase letters, numbers and hyphens');
const baseDir = path.resolve(process.env.FLINT_BRIDGE_HOME || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support/Flint/bridge' : '.local/share/flint/bridge'));
const stateDir = path.join(baseDir, profile), configFile = path.join(stateDir, 'config.json');
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
function interval(value: string | undefined, fallback = 5) { const result = value === undefined ? fallback : Number(value); if (!Number.isFinite(result) || result < 0.05 || result > 1440) throw new Error('Interval must be between 0.05 and 1440 minutes'); return result; }
function mode(value?: string): 'interval' | 'change' { if (value && value !== 'interval' && value !== 'change') throw new Error('Mode must be interval or change'); return value === 'interval' ? 'interval' : 'change'; }
async function config(): Promise<SavedConfig> { try { return JSON.parse(await fs.readFile(configFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Profile ${profile} is not paired. Run the pair command first.`); throw error; } }
async function ask(prompt: string) {
  if (!process.stdin.isTTY) throw new Error('Specify --pairing-file and --folder when pairing noninteractively');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(prompt)).trim(); } finally { input.close(); }
}
async function pair() {
  const source = path.resolve(flags.get('pairing-file') || await ask('Downloaded Flint device pairing JSON path: '));
  const stat = await fs.stat(source); if (stat.size > 1024 * 1024) throw new Error('Pairing file is too large');
  const pairing = validatePairing(JSON.parse(await fs.readFile(source, 'utf8')));
  if (flags.get('server') && new URL(flags.get('server')!).origin !== pairing.server || flags.get('vault') && flags.get('vault') !== pairing.vaultId) throw new Error('--server/--vault must match the downloaded pairing file');
  const folderArg = path.resolve(flags.get('folder') || await ask('Local Obsidian vault folder (new or existing): '));
  await fs.mkdir(folderArg, { recursive: true, mode: 0o700 });
  const folder = await fs.realpath(folderArg);
  let previous: SavedConfig | undefined; try { previous = await config(); } catch { /* first pairing */ }
  if (previous && (previous.folder !== folder || previous.vaultId !== pairing.vaultId || previous.server !== pairing.server)) throw new Error('This profile belongs to another folder/vault. Use a different --profile instead of replacing its sync history.');
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  for (const other of await fs.readdir(baseDir, { withFileTypes: true })) {
    if (!other.isDirectory() || other.name === profile) continue;
    let mapped: SavedConfig; try { mapped = JSON.parse(await fs.readFile(path.join(baseDir, other.name, 'config.json'), 'utf8')); } catch { continue; }
    const relative = path.relative(mapped.folder, folder), reverse = path.relative(folder, mapped.folder);
    if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) || !reverse.startsWith('..' + path.sep) && reverse !== '..' && !path.isAbsolute(reverse)) throw new Error(`Folder overlaps companion profile ${other.name}. Only one sync engine may own a folder.`);
  }
  const allowFileSecrets = flags.has('allow-file-secrets') || previous?.allowFileSecrets || false;
  const settings: SavedConfig = { server: pairing.server, vaultId: pairing.vaultId, folder, stateDir, allowFileSecrets, interval: interval(flags.get('interval'), previous?.interval), mode: mode(flags.get('mode') || previous?.mode), excludes: flags.has('exclude') ? flags.get('exclude')!.split(',').filter(Boolean) : previous?.excludes || [], extensions: flags.has('types') ? flags.get('types')!.split(',').filter(Boolean) : previous?.extensions || [], obsidianSettings: flags.has('obsidian-settings') || previous?.obsidianSettings || false };
  new BridgeEngine(settings, pairing); // Validate that state is outside the selected vault before enrollment.
  // Verify token, vault and keys before saving enrollment or touching note files.
  const response = await fetch(`${pairing.server}/api/vaults/${encodeURIComponent(pairing.vaultId)}/manifests?after=0`, { headers: { Authorization: `Bearer ${pairing.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Pairing was rejected by the server (${response.status})`);
  const page = await response.json() as { files: FileManifest[] };
  for (const file of page.files) {
    if (file.manifestBox) await decryptManifest(file, pairing.keyring);
    else {
      const legacyResponse = await fetch(`${pairing.server}/api/vaults/${encodeURIComponent(pairing.vaultId)}/files/${encodeURIComponent(file.id)}?revision=${file.revision}`, { headers: { Authorization: `Bearer ${pairing.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!legacyResponse.ok) throw new Error('Could not validate a legacy encrypted file during pairing');
      const legacy = await legacyResponse.json() as { file: FileRecord }; await decryptFile(legacy.file, pairing.keyring);
    }
  }
  await savePairing(stateDir, pairing, allowFileSecrets);
  await atomicJson(configFile, settings);
  if (previous && (JSON.stringify(previous.excludes) !== JSON.stringify(settings.excludes) || JSON.stringify(previous.extensions) !== JSON.stringify(settings.extensions) || previous.obsidianSettings !== settings.obsidianSettings)) {
    const state = await readState(stateDir); state.cursor = 0; await atomicJson(path.join(stateDir, 'state.json'), state);
  }
  if (flags.has('remove-pairing-file')) await fs.unlink(source);
  log(`Paired ${profile}: ${folder}. Credentials stored in ${allowFileSecrets ? 'a restricted local credential file' : 'macOS Keychain'}.`);
  log('Run once to review the initial merge, then install for automatic background sync. Existing local files are preserved as conflict copies when needed.');
  if (!flags.has('remove-pairing-file')) log('Delete the downloaded pairing JSON after confirming enrollment; it contains your vault keys and device token.');
}
async function run(once: boolean) {
  const settings = await config(), credentials = await loadPairing(stateDir, flags.has('allow-file-secrets') || settings.allowFileSecrets);
  const engine = new BridgeEngine(settings, credentials, log);
  if (once) { await engine.syncOnce(); return; }
  const minutes = interval(flags.get('interval'), settings.interval), selectedMode = mode(flags.get('mode') || settings.mode);
  let stopped = false, working = false, again = false, failures = 0, debounce: NodeJS.Timeout | undefined, retry: NodeJS.Timeout | undefined;
  const cycle = async () => {
    if (stopped) return;
    if (working) { again = true; return; }
    working = true;
    try { await engine.syncOnce(); failures = 0; }
    catch (error) {
      log((error as Error).message);
      if (error instanceof RotationRequiredError || error instanceof ApiError && [401, 403].includes(error.status)) { stopped = true; process.exitCode = 1; await close(); }
      else { failures++; retry = setTimeout(() => { void cycle(); }, Math.min(300_000, 5000 * 2 ** Math.min(failures - 1, 6))); }
    } finally { working = false; if (again && !stopped) { again = false; debounce = setTimeout(() => { void cycle(); }, 2000); } }
  };
  const ticker = setInterval(() => { void cycle(); }, minutes * 60_000);
  const watcher = selectedMode === 'change' ? chokidar.watch(settings.folder, { ignoreInitial: true, ignored: /(?:^|[/\\])(?:\.git|\.flint|\.flint-tmp-[^/\\]*)(?:$|[/\\])/, awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } }) : undefined;
  watcher?.on('all', () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { void cycle(); }, 2000); });
  watcher?.on('error', error => log(`Folder watcher: ${(error as Error).message}. Periodic reconciliation remains active.`));
  const close = async () => { stopped = true; clearInterval(ticker); if (debounce) clearTimeout(debounce); if (retry) clearTimeout(retry); await watcher?.close(); };
  process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
  log(`Background sync: ${selectedMode}, reconciliation every ${minutes} minute(s).`);
  await cycle();
}
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
async function launchAgent(remove: boolean) {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent installation is available only on macOS. On Linux, run the companion with your service manager.');
  const uid = process.getuid!(), label = `app.flint.bridge.${profile}`, directory = path.join(os.homedir(), 'Library/LaunchAgents'), plist = path.join(directory, `${label}.plist`);
  if (remove) { spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`]); await fs.rm(plist, { force: true }); log('Background service removed. Local notes, sync history and Keychain credentials remain available.'); return; }
  const settings = await config();
  const current = fileURLToPath(import.meta.url), entry = current.endsWith('.ts') ? path.resolve(path.dirname(current), '../dist-bridge/cli.js') : current;
  try { await fs.access(entry); } catch { throw new Error('Build the companion first with npm run build, then run install again'); }
  const programArgs = [process.execPath, entry, 'run', '--profile', profile, '--interval', String(interval(flags.get('interval'), settings.interval)), '--mode', mode(flags.get('mode') || settings.mode)];
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, 'bridge.log'); await fs.appendFile(logPath, '', { mode: 0o600 });
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${programArgs.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>FLINT_BRIDGE_HOME</key><string>${xml(baseDir)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(logPath)}</string></dict></plist>\n`;
  await fs.writeFile(plist, contents, { mode: 0o600 });
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`]);
  // bootout may return before launchd finishes removing the job. A direct
  // bootstrap can transiently fail with EIO even though the plist is valid.
  const target = `gui/${uid}/${label}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status !== 0) break;
    if (attempt === 39) throw new Error('Previous LaunchAgent is still stopping. Try install again after it exits.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  let failure = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
    if (result.status === 0 || spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0) { failure = ''; break; }
    failure = result.stderr.trim();
    await new Promise(resolve => setTimeout(resolve, Math.min(250 * (attempt + 1), 1000)));
  }
  if (failure) throw new Error(`Could not start LaunchAgent: ${failure}`);
  log(`Installed and started ${label}. Logs: ${logPath}`);
}
async function main() {
  switch (command) {
    case 'pair': return pair();
    case 'once': return run(true);
    case 'run': return run(false);
    case 'status': { const settings = await config(), state = await readState(stateDir); console.log(JSON.stringify({ profile, server: settings.server, vaultId: settings.vaultId, folder: settings.folder, mode: settings.mode, intervalMinutes: settings.interval, lastSuccess: state.lastSuccess || null, lastAttempt: state.lastAttempt || null, lastError: state.lastError || null, pending: state.pending.length, files: Object.values(state.files).filter(file => !file.deleted && file.selected).length, cursor: state.cursor }, null, 2)); return; }
    case 'install': return launchAgent(false);
    case 'uninstall': return launchAgent(true);
    default: console.log(`Flint companion — automatic encrypted Obsidian folder sync\n\n  pair --pairing-file PATH --folder PATH [--profile default]\n       [--interval 5] [--mode change|interval] [--exclude private,archive]\n       [--types md,canvas,png] [--obsidian-settings] [--remove-pairing-file]\n  once [--profile default]\n  run [--profile default] [--interval 5] [--mode change|interval]\n  status [--profile default]\n  install [--profile default] [--interval 5] [--mode change|interval]\n  uninstall [--profile default]\n\nOn macOS, credentials use Keychain. --allow-file-secrets is an explicit\nLinux/testing fallback. FLINT_BRIDGE_HOME overrides the state directory.\nNever run two sync services on the same local folder.`);
  }
}
main().catch(error => { console.error(`Flint companion: ${(error as Error).message}`); process.exitCode = 1; });
