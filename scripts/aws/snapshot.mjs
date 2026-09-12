import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error('Usage: node snapshot.mjs source.db snapshot.db');
if (resolve(source) === resolve(target) || existsSync(target)) throw new Error('Snapshot destination must be a new, separate database');
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
} finally {
  db.close();
}
// A backup of a WAL database retains WAL mode. Opening that destination read-only
// can leave -wal/-shm files behind, even when all pages are already in the DB.
// Normalize only the disposable destination to a standalone rollback-journal DB.
const restored = new DatabaseSync(target);
try {
  if (restored.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy !== 0) throw new Error('Snapshot checkpoint is busy');
  if (restored.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw new Error('Snapshot could not leave WAL mode');
  if (restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Snapshot integrity check failed');
  if (restored.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Snapshot foreign key check failed');
} finally {
  restored.close();
}
if (['-wal', '-shm', '-journal'].some(suffix => existsSync(target + suffix))) throw new Error('Snapshot has unexpected SQLite sidecar files');
