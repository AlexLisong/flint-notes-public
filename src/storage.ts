import {openDB} from 'idb';
import type {FileRecord,FileWrite, Vault, Session} from '../shared/types';
export interface Pending{key:string;vaultId:string;write:FileWrite;queuedAt:number}
const db=openDB('flint-encrypted',2,{upgrade(d,oldVersion,_newVersion,tx){if(oldVersion<1){d.createObjectStore('files',{keyPath:'id'});d.createObjectStore('outbox',{keyPath:'key'});d.createObjectStore('meta');d.createObjectStore('chunks');}if(oldVersion<2){d.createObjectStore('vaultFiles',{keyPath:'cacheKey'});const legacy=tx.objectStore('files');legacy.openCursor().then(function migrate(cursor):Promise<void>|void{if(!cursor)return;const r=cursor.value;tx.objectStore('vaultFiles').put({...r,cacheKey:r.vaultId+':'+r.id});return cursor.continue().then(migrate);});}}});
export const storage={
 async records(vaultId:string):Promise<FileRecord[]>{return (await (await db).getAll('vaultFiles')).filter((r:FileRecord)=>r.vaultId===vaultId);},
 async record(r:FileRecord){await (await db).put('vaultFiles',{...r,cacheKey:r.vaultId+':'+r.id});},
 async pending(vaultId:string):Promise<Pending[]>{return (await (await db).getAll('outbox')).filter((r:Pending)=>r.vaultId===vaultId).sort((a:Pending,b:Pending)=>a.queuedAt-b.queuedAt);},
 async putPending(p:Pending){await (await db).put('outbox',p);},
 async dropPending(key:string){await (await db).delete('outbox',key);},
 async meta<T>(key:string):Promise<T|undefined>{return(await db).get('meta',key);},
 async setMeta(key:string,value:any){await(await db).put('meta',value,key);},
 async chunk(id:string){return(await db).get('chunks',id) as Promise<Uint8Array|undefined>;},
 async putChunk(id:string,bytes:Uint8Array){await(await db).put('chunks',bytes,id);},
 async clear(){const d=await db;for(const s of ['files','vaultFiles','outbox','meta','chunks'])await d.clear(s);},
 async cacheAuth(session:Session,vaults:Vault[]){await this.setMeta('offline-auth',{session,vaults});}
};
