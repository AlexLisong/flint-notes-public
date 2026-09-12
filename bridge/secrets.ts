import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateKeyring } from '../shared/crypto';
import { atomicJson, type Pairing } from './engine';

const service = 'flint-notes-bridge';
const account = (stateDir: string) => createHash('sha256').update(path.resolve(stateDir)).digest('hex');
export function validatePairing(value: unknown): Pairing {
  const pairing = value as Pairing;
  if (!pairing || typeof pairing.server !== 'string' || typeof pairing.vaultId !== 'string' || !/^[0-9a-f-]{36}$/i.test(pairing.vaultId) || typeof pairing.token !== 'string' || pairing.token.length < 16) throw new Error('Invalid pairing file. Download a new device pairing file from Flint.');
  const server = new URL(pairing.server);
  if (server.username || server.password || server.search || server.hash || server.pathname !== '/') throw new Error('Pairing server must be an origin without credentials or a path');
  if (server.protocol !== 'https:' && !(server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname))) throw new Error('Remote pairing requires HTTPS');
  return { server: server.origin, vaultId: pairing.vaultId, token: pairing.token, keyring: validateKeyring(pairing.keyring) };
}
export async function savePairing(stateDir: string, pairing: Pairing, allowFileSecrets = false) {
  const valid = validatePairing(pairing);
  if (process.platform === 'darwin' && !allowFileSecrets) {
    // Interactive stdin avoids placing the secret in the process argument list.
    const encoded = Buffer.from(JSON.stringify(valid)).toString('base64');
    const command = `add-generic-password -U -a ${account(stateDir)} -s ${service} -w ${encoded}\n`;
    const result = spawnSync('/usr/bin/security', ['-i'], { input: command, encoding: 'utf8' });
    if (result.status !== 0 || /SecKeychain|error:|Error:/.test(result.stderr || '')) throw new Error('Could not save device credentials in macOS Keychain');
    // Confirm persistence without printing credentials.
    const stored = await loadPairing(stateDir, false);
    if (stored.token !== valid.token || stored.keyring.currentEpoch !== valid.keyring.currentEpoch) throw new Error('macOS Keychain credential verification failed');
    await fs.rm(path.join(stateDir, 'pairing-secret.json'), { force: true });
    return;
  }
  if (!allowFileSecrets) throw new Error('macOS Keychain is required. Linux/testing can explicitly use --allow-file-secrets (restricted plaintext credential file).');
  await atomicJson(path.join(stateDir, 'pairing-secret.json'), valid);
}
export async function loadPairing(stateDir: string, allowFileSecrets = false): Promise<Pairing> {
  if (process.platform === 'darwin' && !allowFileSecrets) {
    const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', account(stateDir), '-s', service, '-w'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Device credentials are unavailable in macOS Keychain. Unlock your login keychain or pair again.');
    try { return validatePairing(JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'))); }
    catch { throw new Error('Stored device credentials are invalid; pair again'); }
  }
  if (!allowFileSecrets) throw new Error('This platform requires explicit --allow-file-secrets, or pair on macOS with Keychain');
  const file = path.join(stateDir, 'pairing-secret.json'), stat = await fs.stat(file);
  if ((stat.mode & 0o077) !== 0) throw new Error('Credential file must have mode 0600');
  return validatePairing(JSON.parse(await fs.readFile(file, 'utf8')));
}
