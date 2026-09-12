import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createVaultCrypto,decryptFile,decryptManifest,encryptFile,encryptManifest,type Keyring} from '../shared/crypto';
import type {FileData,FileRecord,FileWrite,Vault} from '../shared/types';
import type {Pending} from '../src/storage';

const temp=await mkdtemp(path.join(tmpdir(),'flint-client-sync-'));
const bundle=path.join(temp,'sync.mjs');
await build({entryPoints:[path.resolve('src/sync.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',plugins:[{name:'controlled-client-boundaries',setup(builder){
 builder.onResolve({filter:/^\.\/(storage|api)$/},args=>({path:args.path.slice(2),namespace:'test-boundary'}));
 builder.onLoad({filter:/.*/,namespace:'test-boundary'},args=>({loader:'js',contents:args.path==='storage'?'export const storage=new Proxy({}, {get:(_,key)=>globalThis.__flintSyncStorage[key]});':`export const api=(...args)=>globalThis.__flintSyncApi(...args);export class ApiError extends Error{constructor(status,body){super(body.error);this.status=status;this.body=body;}}export const getBytes=()=>{throw new Error('Unexpected chunk GET');};`}));
}}]});
const {VaultSync}=await import(pathToFileURL(bundle).href) as {VaultSync:typeof import('../src/sync').VaultSync};
after(()=>rm(temp,{recursive:true,force:true}));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(){
 const id=crypto.randomUUID(),cryptoData=await createVaultCrypto(id,'synthetic client sync test phrase');
 const vault:Vault={id,name:'Synthetic vault',role:'owner',epoch:1,salt:cryptoData.salt,keyBox:cryptoData.keyBox,createdAt:new Date().toISOString()};
 const cache=new Map<string,FileRecord>(),pending=new Map<string,Pending>(),meta=new Map<string,unknown>(),remote=new Map<string,FileRecord>(),revisions=new Map<string,FileRecord>();
 const gets:string[]=[],requestedRevisions:number[]=[],manifestCursors:number[]=[];let sequence=0;
 const hooks:{beforeGet?:(id:string)=>Promise<void>;beforePut?:(write:FileWrite)=>Promise<void>;beforePending?:(pending:Pending)=>Promise<void>}={};
 (globalThis as any).__flintSyncStorage={
  records:async()=>structuredClone([...cache.values()]),record:async(record:FileRecord)=>cache.set(record.id,structuredClone(record)),
  pending:async()=>structuredClone([...pending.values()]),putPending:async(row:Pending)=>{await hooks.beforePending?.(row);pending.set(row.key,structuredClone(row));},dropPending:async(key:string)=>pending.delete(key),
  meta:async(key:string)=>structuredClone(meta.get(key)),setMeta:async(key:string,value:unknown)=>meta.set(key,structuredClone(value))
 };
 (globalThis as any).__flintSyncApi=async(url:string,init?:RequestInit)=>{
  if(init?.method==='PUT'){
   const write=JSON.parse(String(init.body)) as FileWrite;await hooks.beforePut?.(write);
   const record:FileRecord={...write,vaultId:id,revision:write.baseRevision+1,seq:++sequence,updatedAt:new Date().toISOString()};
   remote.set(record.id,record);revisions.set(record.id+':'+record.revision,record);return {file:structuredClone(record)};
  }
  if(url.includes('/manifests?')){
   const cursor=Number(url.split('after=')[1]);manifestCursors.push(cursor);
   return {files:[...remote.values()].filter(record=>record.seq>cursor).sort((a,b)=>a.seq-b.seq).map(({box,...header})=>header),cursor:sequence,hasMore:false};
  }
  const parsed=new URL(url,'http://synthetic.test');const fileId=parsed.pathname.split('/').pop()!;const revision=Number(parsed.searchParams.get('revision'));gets.push(fileId);requestedRevisions.push(revision);await hooks.beforeGet?.(fileId);
  assert.ok(revision>0,'body requests must pin an immutable revision');assert.ok(revisions.has(fileId+':'+revision));return {file:structuredClone(revisions.get(fileId+':'+revision))};
 };
 async function put(path:string,content:string,id:string=crypto.randomUUID(),revision=1,legacy=false){
  const data={path,content};const box=await encryptFile(vault.id,id,revision,false,data,cryptoData.keyring);
  const manifestBox=legacy?undefined:await encryptManifest(vault.id,id,revision,false,data,cryptoData.keyring);
  const row:FileRecord={id,vaultId:vault.id,revision,epoch:1,deleted:false,box,manifestBox,updatedAt:new Date().toISOString(),seq:++sequence};remote.set(id,row);revisions.set(id+':'+revision,row);return row;
 }
 const sync=new VaultSync(vault,cryptoData.keyring,()=>{});
 return {sync,put,vault,keys:cryptoData.keyring,cache,pending,meta,remote,gets,requestedRevisions,manifestCursors,hooks};
}

test('manifest selection skips excluded folder and file-type body requests; reinclusion replays metadata',async()=>{
 const f=await fixture();const allowed=await f.put('Notes/Included.md','included body');const folder=await f.put('Archive/Private.md','excluded body');const type=await f.put('Media/movie.mp4','excluded movie');
 await f.sync.setSelection('Archive/','mp4');await f.sync.init();await f.sync.pull();
 assert.deepEqual(f.gets,[allowed.id]);assert.deepEqual([...f.cache.keys()],[allowed.id]);assert.equal(f.sync.state.files.length,1);
 await f.sync.setSelection('','');await f.sync.pull();
 assert.equal(f.manifestCursors.at(-1),0);assert.deepEqual(new Set(f.gets),new Set([allowed.id,folder.id,type.id]));assert.equal(f.cache.size,3);
 await f.sync.setSelection('Archive','');assert.ok(f.cache.has(folder.id),'cached content retained');assert.ok(f.sync.state.excludedIds?.includes(folder.id));
});

test('selection changed during a body fetch prevents caching and restarts from metadata cursor zero',async()=>{
 const f=await fixture();const row=await f.put('Archive/Changing.md','body already in flight');const started=gate(),release=gate();
 f.hooks.beforeGet=async()=>{started.resolve();await release.promise;};
 await f.sync.init();const pulling=f.sync.pull();await started.promise;await f.sync.setSelection('Archive','');release.resolve();await pulling;
 assert.equal(f.cache.size,0);assert.equal(f.sync.state.files.length,0);assert.deepEqual(f.manifestCursors,[0,0]);
});

test('a head renamed into an excluded folder is never downloaded instead of the selected immutable revision',async()=>{
 const f=await fixture();const row=await f.put('Notes/Selected.md','old content');await f.sync.setSelection('Archive','');await f.sync.init();
 f.hooks.beforeGet=async()=>{f.hooks.beforeGet=undefined;await f.put('Archive/Moved.md','newer excluded content',row.id,2);};
 await f.sync.pull();assert.equal(f.cache.get(row.id)?.revision,1);assert.deepEqual(f.requestedRevisions,[1]);await f.sync.pull();assert.deepEqual(f.gets,[row.id]);assert.ok(f.sync.state.excludedIds?.includes(row.id));
});

test('an excluded manifest hides an older cached path without downloading or deleting it',async()=>{
 const f=await fixture();const row=await f.put('Notes/Old.md','downloaded copy');await f.sync.setSelection('Archive','');await f.sync.init();await f.sync.pull();
 await f.put('Archive/Moved.md','new excluded version',row.id,2);await f.sync.pull();
 assert.deepEqual(f.gets,[row.id]);assert.equal(f.cache.get(row.id)?.revision,1);assert.ok(f.sync.state.excludedIds?.includes(row.id));
});

test('legacy rows need one content fetch but excluded bodies do not enter the cache',async()=>{
 const f=await fixture();const row=await f.put('Archive/Legacy.md','legacy body',crypto.randomUUID(),1,true);await f.sync.setSelection('Archive','');await f.sync.init();await f.sync.pull();
 assert.deepEqual(f.gets,[row.id]);assert.equal(f.cache.size,0);await f.sync.pull();assert.equal(f.gets.length,1);
});

test('new encrypted writes include a path-only manifest and preserve the newest edit during ACK rebase',async()=>{
 const f=await fixture();const fileId=crypto.randomUUID(),started=gate(),releaseResponse=gate(),rebasing=gate(),releaseRebase=gate();
 f.hooks.beforePut=async()=>{started.resolve();await releaseResponse.promise;};
 await f.sync.init();await f.sync.stage({path:'Notes/Editing.md',content:'version ONE'},fileId);
 const syncing=f.sync.sync();await started.promise;await f.sync.stage({path:'Notes/Editing.md',content:'version TWO'},fileId);
 f.hooks.beforePending=async row=>{if(row.write.baseRevision===1){f.hooks.beforePending=undefined;rebasing.resolve();await releaseRebase.promise;}};
 releaseResponse.resolve();await rebasing.promise;
 const newest=f.sync.stage({path:'Notes/Editing.md',content:'version THREE newest'},fileId);releaseRebase.resolve();await newest;await syncing;
 const queued=[...f.pending.values()][0];assert.ok(queued);
 const record:FileRecord={...queued.write,vaultId:f.vault.id,revision:queued.write.baseRevision+1,seq:0,updatedAt:new Date().toISOString()};
 assert.equal((await decryptFile(record,f.keys)).content,'version THREE newest');assert.equal(f.sync.state.files.find(row=>row.id===fileId)?.content,'version THREE newest');
 assert.deepEqual(await decryptManifest(record,f.keys),{path:'Notes/Editing.md'});assert.equal(queued.write.baseRevision,1);
});

test('selective cache state survives unlock and newer selected revisions require their own manifest',async()=>{
 const f=await fixture();const selected=await f.put('Notes/Selected.md','old content');await f.sync.setSelection('Archive','');await f.sync.init();
 f.hooks.beforeGet=async()=>{f.hooks.beforeGet=undefined;await f.put('Notes/Renamed.md','new selected content',selected.id,2);};
 await f.sync.pull();assert.equal(f.cache.get(selected.id)?.revision,1);await f.sync.pull();assert.deepEqual(f.requestedRevisions,[1,2]);assert.equal(f.cache.get(selected.id)?.revision,2);assert.equal(f.sync.state.files[0].path,'Notes/Renamed.md');
 await f.put('Archive/Now excluded.md','private future content',selected.id,3);await f.sync.pull();
 const reopened=new VaultSync(f.vault,f.keys,()=>{});await reopened.setSelection('Archive','');await reopened.init();
 assert.ok(reopened.state.excludedIds?.includes(selected.id));assert.equal(reopened.state.files[0].content,'new selected content');assert.equal(f.cache.get(selected.id)?.revision,2);
});
