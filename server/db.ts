import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
export function openDatabase(directory:string) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const filename=join(directory,'flint.db');
  const db=new DatabaseSync(filename);chmodSync(filename,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,key_box TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,seq INTEGER NOT NULL DEFAULT 0,retention_days INTEGER NOT NULL DEFAULT 365,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members(vault_id TEXT NOT NULL REFERENCES vaults(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(vault_id,user_id));
  CREATE TABLE IF NOT EXISTS files(vault_id TEXT NOT NULL REFERENCES vaults(id),id TEXT NOT NULL,revision INTEGER NOT NULL,epoch INTEGER NOT NULL,box TEXT NOT NULL,deleted INTEGER NOT NULL,updated_at TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(vault_id,id));
  CREATE INDEX IF NOT EXISTS files_seq ON files(vault_id,seq);
  CREATE TABLE IF NOT EXISTS revisions(vault_id TEXT NOT NULL,file_id TEXT NOT NULL,revision INTEGER NOT NULL,epoch INTEGER NOT NULL,box TEXT NOT NULL,deleted INTEGER NOT NULL,updated_at TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(vault_id,file_id,revision),FOREIGN KEY(vault_id,file_id) REFERENCES files(vault_id,id));
  CREATE TABLE IF NOT EXISTS mutations(vault_id TEXT NOT NULL,id TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(vault_id,id));
  CREATE TABLE IF NOT EXISTS chunks(vault_id TEXT NOT NULL REFERENCES vaults(id),id TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(vault_id,id));
  CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),vault_id TEXT NOT NULL REFERENCES vaults(id),name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,last_used_at TEXT);
  CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),role TEXT NOT NULL,expires INTEGER NOT NULL,used_by TEXT REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,vault_id TEXT NOT NULL REFERENCES vaults(id),slug TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',theme TEXT NOT NULL DEFAULT 'light',accent TEXT NOT NULL DEFAULT '#b77c2c',noindex INTEGER NOT NULL DEFAULT 0,password_hash TEXT,revision INTEGER NOT NULL DEFAULT 0,published INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS published_notes(site_id TEXT NOT NULL REFERENCES sites(id),id TEXT NOT NULL,path TEXT NOT NULL,title TEXT NOT NULL,slug TEXT NOT NULL,content TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(site_id,id),UNIQUE(site_id,slug));
  CREATE TABLE IF NOT EXISTS published_assets(site_id TEXT NOT NULL REFERENCES sites(id),id TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(site_id,id));
  CREATE TABLE IF NOT EXISTS publication_history(id INTEGER PRIMARY KEY AUTOINCREMENT,site_id TEXT NOT NULL,actor_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,note_count INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS public_sessions(hash TEXT PRIMARY KEY,site_id TEXT NOT NULL REFERENCES sites(id),expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,created_at TEXT NOT NULL);
  PRAGMA user_version=1;`);
  if(!(db.prepare('PRAGMA table_info(files)').all() as any[]).some(c=>c.name==='manifest_box'))db.exec('ALTER TABLE files ADD COLUMN manifest_box TEXT');
  return db;
}
export type DB=ReturnType<typeof openDatabase>;
export function transaction<T>(db:DB,fn:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
