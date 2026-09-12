import type {FileData,FileRecord,FileManifest,LocalFile,Vault} from '../shared/types';
import {encryptFile,decryptFile,encryptManifest,decryptManifest,encryptChunk,decryptChunk,type Keyring} from '../shared/crypto';
import {api,ApiError,getBytes} from './api';
import {storage} from './storage';
import {cleanPath} from './notes';
export interface SyncState{files:LocalFile[];pending:number;syncing:boolean;lastSync?:string;error?:string;activity:string[];excludedIds?:string[]}
export class VaultSync{
 state:SyncState={files:[],pending:0,syncing:false,activity:[]};cursor=0;busy=false;disposed=false;stages:Promise<unknown>=Promise.resolve();
 private folders:string[]=[];private types:string[]=[];private selectionVersion=0;private initialized=false;private excludedIds=new Set<string>();
 constructor(public vault:Vault,public keys:Keyring,private changed:(state:SyncState)=>void){}
 private get selectionKey(){return JSON.stringify([this.folders,this.types]);}
 isSelected(path:string){return !this.folders.some(folder=>path===folder||path.startsWith(folder+'/'))&&!this.types.some(type=>path.toLowerCase().endsWith('.'+type));}
 setSelection(excludeFolders:string,excludeTypes:string):Promise<void>{return this.serial(async()=>{
  const folders=[...new Set(excludeFolders.split(',').map(value=>value.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean))].sort();
  const types=[...new Set(excludeTypes.split(',').map(value=>value.trim().replace(/^\./,'').toLowerCase()).filter(Boolean))].sort();
  if(JSON.stringify([folders,types])===this.selectionKey)return;
  this.folders=folders;this.types=types;this.selectionVersion++;this.cursor=0;
  this.excludedIds=new Set(this.state.files.filter(file=>!this.isSelected(file.path)).map(file=>file.id));
  this.emit({excludedIds:[...this.excludedIds]});
  if(this.initialized)await this.persistCursor();
 });}
 private async persistCursor(){await storage.setMeta('manifest-cursor:'+this.vault.id,{cursor:this.cursor,selectionKey:this.selectionKey,excludedIds:[...this.excludedIds]});}
 private classify(id:string,path:string){const selected=this.isSelected(path);const wasExcluded=this.excludedIds.has(id);if(selected)this.excludedIds.delete(id);else this.excludedIds.add(id);if(wasExcluded!==!selected)this.emit({excludedIds:[...this.excludedIds]});return selected;}

 emit(p:Partial<SyncState>={}){this.state={...this.state,...p};if(!this.disposed)this.changed(this.state);}
 log(message:string){this.emit({activity:[`${new Date().toLocaleTimeString()} · ${message}`,...this.state.activity].slice(0,40)});}
 replace(file:LocalFile){const files=this.state.files.filter(f=>f.id!==file.id);files.push(file);this.emit({files:files.sort((a,b)=>a.path.localeCompare(b.path))});}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const operation=this.stages.then(fn);this.stages=operation.catch(()=>{});return operation;}
 async init(){return this.serial(async()=>{
  const saved=await storage.meta<{cursor:number;selectionKey:string;excludedIds?:string[]}>('manifest-cursor:'+this.vault.id);
  this.cursor=saved?.selectionKey===this.selectionKey?saved.cursor:0;
  const records=await storage.records(this.vault.id);const files:LocalFile[]=[];
  for(const record of records){try{files.push({...await decryptFile(record,this.keys),id:record.id,revision:record.revision,deleted:record.deleted,updatedAt:record.updatedAt});}catch{this.log('A cached file could not be decrypted.');}}
  this.excludedIds=new Set([...(saved?.selectionKey===this.selectionKey?saved.excludedIds||[]:[]),...files.filter(file=>!this.isSelected(file.path)).map(file=>file.id)]);
  this.emit({files,excludedIds:[...this.excludedIds]});
  for(const pending of await storage.pending(this.vault.id)){
   const record:FileRecord={...pending.write,vaultId:this.vault.id,revision:pending.write.baseRevision+1,updatedAt:new Date(pending.queuedAt).toISOString(),seq:0};
   const data=await decryptFile(record,this.keys);
   this.replace({...data,id:record.id,revision:pending.write.baseRevision,deleted:record.deleted,updatedAt:record.updatedAt,pending:true});
   if(pending.write.epoch!==this.keys.currentEpoch||!pending.write.manifestBox)await this.stageNow(data,record.id,record.deleted,pending.write.baseRevision);
  }
  this.initialized=true;this.emit({pending:(await storage.pending(this.vault.id)).length});
 });}
 stage(data:FileData,id:string=crypto.randomUUID(),deleted=false):Promise<LocalFile>{return this.serial(()=>this.stageNow(data,id,deleted));}
 private async stageNow(data:FileData,id:string,deleted:boolean,forcedBase?:number){if(this.vault.role==='viewer')throw new Error('This vault is read-only.');cleanPath(data.path);const existing=this.state.files.find(f=>f.id===id);const pending=(await storage.pending(this.vault.id)).find(p=>p.write.id===id);const baseRevision=forcedBase??pending?.write.baseRevision??existing?.revision??0;const epoch=this.keys.currentEpoch;const box=await encryptFile(this.vault.id,id,baseRevision+1,deleted,{path:data.path,content:data.content,...(data.attachment?{attachment:data.attachment}:{})},this.keys);const manifestBox=await encryptManifest(this.vault.id,id,baseRevision+1,deleted,data,this.keys);const write={id,baseRevision,epoch,box,manifestBox,deleted,mutationId:crypto.randomUUID()};await storage.putPending({key:this.vault.id+':'+id,vaultId:this.vault.id,write,queuedAt:Date.now()});const file={...data,id,revision:baseRevision,deleted,updatedAt:new Date().toISOString(),pending:true};this.classify(id,data.path);this.replace(file);this.emit({pending:(await storage.pending(this.vault.id)).length});return file;}
 async pull(){
  let more=true;
  while(more&&!this.disposed){
   const request=await this.serial(async()=>({cursor:this.cursor,selectionVersion:this.selectionVersion}));
   const page=await api<{files:FileManifest[];cursor:number;hasMore:boolean}>(`/vaults/${this.vault.id}/manifests?after=${request.cursor}`);
   let restart=false;
   for(const header of page.files){
    const decision=await this.serial(async()=>{
     if(request.selectionVersion!==this.selectionVersion)return 'restart';
     if(header.vaultId!==this.vault.id)throw new Error('A file manifest belongs to a different vault.');
     if((await storage.pending(this.vault.id)).some(pending=>pending.write.id===header.id))return 'skip';
     const current=this.state.files.find(file=>file.id===header.id);
     if(current&&current.revision>=header.revision){this.classify(current.id,current.path);return 'skip';}
     if(header.manifestBox){const metadata=await decryptManifest(header,this.keys);if(!this.classify(header.id,metadata.path))return 'skip';}
     // Old clients may have written records without separate encrypted metadata.
     // Fetching their body once is required to discover and filter their path.
     return 'fetch';
    });
    if(decision==='restart'){restart=true;break;}
    if(decision==='skip')continue;
    const {file:record}=await api<{file:FileRecord}>(`/vaults/${this.vault.id}/files/${header.id}?revision=${header.revision}`);
    await this.serial(async()=>{
     if(request.selectionVersion!==this.selectionVersion){restart=true;return;}
     if(record.vaultId!==this.vault.id||record.id!==header.id||record.revision!==header.revision)throw new Error('The downloaded file did not match its manifest. Retry sync.');
     if((await storage.pending(this.vault.id)).some(pending=>pending.write.id===record.id))return;
     const current=this.state.files.find(file=>file.id===record.id);
     if(current&&current.revision>=record.revision){this.classify(current.id,current.path);return;}
     const data=await decryptFile(record,this.keys);
     for(const source of [record,...(header.revision===record.revision?[header]:[])]){if(source.manifestBox){const metadata=await decryptManifest(source,this.keys);if(metadata.path!==data.path||Boolean(metadata.attachment)!==Boolean(data.attachment)||metadata.attachment?.mime!==data.attachment?.mime||metadata.attachment?.size!==data.attachment?.size)throw new Error('The encrypted file does not match its metadata.');}}
     // Fetch the exact authenticated revision selected by the manifest.
     // Recheck its path before storing or displaying the decrypted content.
     if(!this.classify(record.id,data.path))return;
     await storage.record(record);
     this.replace({...data,id:record.id,revision:record.revision,deleted:record.deleted,updatedAt:record.updatedAt});
    });
    if(restart)break;
   }
   await this.serial(async()=>{
    if(restart||request.selectionVersion!==this.selectionVersion){restart=true;return;}
    this.cursor=page.cursor;await this.persistCursor();
   });
   more=restart||page.hasMore;
  }
 }
 async sync(){if(this.busy||this.disposed)return;this.busy=true;this.emit({syncing:true,error:undefined});try{await this.stages;const queue=await storage.pending(this.vault.id);for(const pending of queue){try{const {file}=await api<{file:FileRecord}>(`/vaults/${this.vault.id}/files/${pending.write.id}`,{method:'PUT',body:JSON.stringify(pending.write)});await this.serial(async()=>{await storage.record(file);const latest=(await storage.pending(this.vault.id)).find(p=>p.key===pending.key);if(latest?.write.mutationId===pending.write.mutationId){await storage.dropPending(pending.key);this.replace({...await decryptFile(file,this.keys),id:file.id,revision:file.revision,deleted:file.deleted,updatedAt:file.updatedAt});}else if(latest){const local=this.state.files.find(f=>f.id===file.id);if(local)await this.stageNow(local,local.id,local.deleted,file.revision);}});}catch(e){if(e instanceof ApiError&&e.status===409){await this.serial(async()=>{const latest=(await storage.pending(this.vault.id)).find(p=>p.key===pending.key);if(!latest)return;const local=this.state.files.find(f=>f.id===pending.write.id);if(local){const suffix=` (conflict ${new Date().toISOString().replace(/[:.]/g,'-')})`;const path=local.path.replace(/(\.[^/.]+)?$/,`${suffix}$1`);await this.stageNow({...local,path},crypto.randomUUID(),false);}await storage.dropPending(pending.key);const remote=e.body.file as FileRecord|undefined;if(remote){await storage.record(remote);this.replace({...await decryptFile(remote,this.keys),id:remote.id,revision:remote.revision,deleted:remote.deleted,updatedAt:remote.updatedAt});}else this.emit({files:this.state.files.filter(f=>f.id!==pending.write.id)});this.log('Concurrent edit preserved as a conflict copy.');});}else throw e;}}await this.pull();this.emit({lastSync:new Date().toLocaleTimeString(),pending:(await storage.pending(this.vault.id)).length});}catch(e){this.emit({error:e instanceof ApiError&&e.status===412?'Vault keys changed. Lock and unlock with the new phrase. Your queued edits remain encrypted on this device.':e instanceof Error?e.message:'Sync failed. Your queued edits are saved on this device.'});}finally{this.busy=false;this.emit({syncing:false});}}
 async upload(file:File,path=file.name){if(file.size>200*1024*1024)throw new Error('Files must be 200 MB or smaller.');const chunks:string[]=[];for(let offset=0;offset<file.size;offset+=1024*1024){const id=crypto.randomUUID();const bytes=await encryptChunk(this.vault.id,id,new Uint8Array(await file.slice(offset,offset+1024*1024).arrayBuffer()),this.keys);await api(`/vaults/${this.vault.id}/chunks/${id}`,{method:'PUT',body:bytes as unknown as BodyInit,headers:{'Content-Type':'application/octet-stream'}});await storage.putChunk(this.vault.id+':'+id,bytes);chunks.push(id);}return this.stage({path,content:'',attachment:{mime:file.type||'application/octet-stream',size:file.size,chunks,epoch:this.keys.currentEpoch}});}
 async attachment(file:LocalFile){if(!file.attachment)return new TextEncoder().encode(file.content);const parts:Uint8Array[]=[];for(const id of file.attachment.chunks){let encrypted=await storage.chunk(this.vault.id+':'+id);if(!encrypted){encrypted=await getBytes(`/vaults/${this.vault.id}/chunks/${id}`);await storage.putChunk(this.vault.id+':'+id,encrypted);}parts.push(await decryptChunk(this.vault.id,id,encrypted,this.keys,file.attachment.epoch));}const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result;}
}
