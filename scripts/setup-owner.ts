/** Provision the user's private owner account. Never logs credentials or content. */
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createVaultCrypto,encryptFile,encryptManifest,unlockVault} from '../shared/crypto';
import type {Vault} from '../shared/types';
const args=process.argv.slice(2);const arg=(k:string,fallback?:string)=>{const i=args.indexOf(k);return i>=0?args[i+1]:fallback;};
const server=arg('--url','http://127.0.0.1:5191')!;
const directory=resolve(arg('--output','.data/owner')!);mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
function save(name:string,value:unknown){const p=join(directory,name),temporary=join(directory,`.${name}.${randomUUID()}.tmp`);writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx',flush:true});renameSync(temporary,p);chmodSync(p,0o600);}
const loginPath=join(directory,'owner-login.json');
const login=existsSync(loginPath)?JSON.parse(readFileSync(loginPath,'utf8')):{url:server,email:arg('--email','owner@example.test'),name:arg('--name','Owner'),password:randomBytes(24).toString('base64url'),vaultPassphrase:randomBytes(27).toString('base64url')};
if(login.url!==server)throw new Error('Existing owner credentials belong to a different server.');save('owner-login.json',login);
let cookie='',csrf='';
async function api(path:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const r=await fetch(server+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});const result=await r.json();if(!r.ok)throw Object.assign(new Error(result.error),{status:r.status});const c=r.headers.getSetCookie().find(c=>c.startsWith('flint_session='));if(c)cookie=c.split(';')[0];if(result.csrf)csrf=result.csrf;return result;
}
let session;
try{session=await api('/auth/login',{email:login.email,password:login.password});}catch(e:any){if(e.status!==401)throw e;let code=process.env.FLINT_BOOTSTRAP_CODE;const envFile=arg('--env-file');if(envFile)code=readFileSync(envFile,'utf8').split('\n').find(l=>l.startsWith('FLINT_BOOTSTRAP_CODE='))?.slice('FLINT_BOOTSTRAP_CODE='.length);if(!code&&server.startsWith('http://127.0.0.1'))code='flint-local-development';if(!code)throw new Error('Registration code is required for first setup.');session=await api('/auth/register',{email:login.email,password:login.password,name:login.name,code});}
let vault:Vault|undefined=(await api('/vaults')).vaults.find((v:Vault)=>v.id===login.vaultId);
if(!vault){const id=randomUUID(),c=await createVaultCrypto(id,login.vaultPassphrase);vault=(await api('/vaults',{id,name:'Personal',salt:c.salt,keyBox:c.keyBox})).vault;login.vaultId=id;save('owner-login.json',login);}
const keys=await unlockVault(vault!.id,vault!.epoch,vault!.salt,vault!.keyBox,login.vaultPassphrase);
if(!login.seeded&&!args.includes('--no-seed')){const initial=await api(`/vaults/${vault!.id}/manifests`);if(initial.files.length===0){for(const [path,content] of [
 ['Welcome.md','# Welcome to Flint\n\nA quiet place for connected thoughts. Your notes belong to you.\n\n- Write here or in your local Obsidian folder.\n- Link ideas with [[Getting started]].\n- Open the graph to see connections.\n- Use the clock in the toolbar to restore an earlier version.\n\n## Today\n\nWhat is worth remembering?\n'],
 ['Getting started.md','# Getting started\n\n## Write anywhere\n\nChanges synchronize automatically between your Mac and this workspace. Open **Settings → Sync & storage** to choose an interval.\n\n## Keep your notes\n\nFiles stay in Markdown. Export a vault from the sidebar whenever you need a portable copy.\n\n## Share deliberately\n\nYour vault is private. Publishing makes only the notes you select available on your reading site.\n\nReturn to [[Welcome]].\n'],
 ['Templates/Daily note.md','# {{date}}\n\n## Focus\n\n- [ ] One thing that matters today\n\n## Notes\n\n\n## Reflection\n\n']
 ]){const id=randomUUID();await api(`/vaults/${vault!.id}/files/${id}`,{id,baseRevision:0,epoch:keys.currentEpoch,deleted:false,mutationId:randomUUID(),box:await encryptFile(vault!.id,id,1,false,{path,content},keys),manifestBox:await encryptManifest(vault!.id,id,1,false,{path,content},keys)},'PUT');}}
 login.seeded=true;save('owner-login.json',login);}
let deviceToken:string|undefined,deviceReused=false;
const pairingPath=join(directory,'pairing.json');
if(existsSync(pairingPath)){
 const previous=JSON.parse(readFileSync(pairingPath,'utf8'));
 if(previous.server!==server||previous.vaultId!==vault!.id)throw new Error('Existing pairing credentials belong to a different server or vault. Preserve them and choose another output directory.');
 if(typeof previous.token!=='string')throw new Error('Existing pairing credential is invalid. Preserve it for recovery before retrying setup.');
 const check=await fetch(`${server}/api/vaults/${vault!.id}/manifests?after=0`,{headers:{Authorization:`Bearer ${previous.token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});
 if(check.ok){deviceToken=previous.token;deviceReused=true;await check.body?.cancel();}
 else if(check.status!==401&&check.status!==403)throw new Error(`Existing device credential could not be checked (${check.status}); setup did not issue another device.`);
}
if(!deviceToken)deviceToken=(await api('/devices',{name:'Mac automatic sync',vaultId:vault!.id})).token;
save('pairing.json',{server,vaultId:vault!.id,token:deviceToken,keyring:keys});
const origin=new URL(server);save('browser-state.json',{cookies:[{name:'flint_session',value:cookie.slice('flint_session='.length),domain:origin.hostname,path:'/',expires:Math.floor(Date.now()/1000)+30*86400,httpOnly:true,secure:origin.protocol==='https:',sameSite:'Strict'}],origins:[]});
save('session.json',{user:session.user,csrf});
console.log(JSON.stringify({url:server,vaultId:vault!.id,credentialsFile:loginPath,pairingFile:pairingPath,accountReady:true,deviceReused}));
