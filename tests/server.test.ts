import {test,after,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../server/app';
import {createVaultCrypto,encryptFile,decryptFile,rotateVaultCrypto,encryptChunk,type Keyring} from '../shared/crypto';
import type {FileWrite,FileRecord} from '../shared/types';
const dir=mkdtempSync(join(tmpdir(),'flint-server-'));
const {app,db}=createApp({dataDir:dir,origin:'http://localhost:5191',bootstrapCode:'test-registration-only',disableRateLimit:true});
const owner=request.agent(app),viewer=request.agent(app),outsider=request.agent(app);
let csrf='',viewerCsrf='',ownerId='',viewerId='',vaultId=randomUUID(),ring:Keyring,cryptoInfo:Awaited<ReturnType<typeof createVaultCrypto>>;
const fileId=randomUUID();let head:FileRecord;
before(async()=>{
 const r=await owner.post('/api/auth/register').send({name:'Owner',email:'owner@example.test',password:'correct-owner-password',code:'test-registration-only'}).expect(201);csrf=r.body.csrf;ownerId=r.body.user.id;
 await outsider.post('/api/auth/register').send({name:'Outside',email:'outside@example.test',password:'correct-outside-password',code:'test-registration-only'}).expect(201);
 cryptoInfo=await createVaultCrypto(vaultId,'a separate vault passphrase');ring=cryptoInfo.keyring;
 await owner.post('/api/vaults').set('X-CSRF-Token',csrf).send({id:vaultId,name:'Private knowledge',salt:cryptoInfo.salt,keyBox:cryptoInfo.keyBox}).expect(201);
});
after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
async function write(revision:number,content:string,id=fileId){const x:FileWrite={id,baseRevision:revision,epoch:ring.currentEpoch,deleted:false,mutationId:randomUUID(),box:await encryptFile(vaultId,id,revision+1,false,{path:'Private/秘密.md',content},ring)};return x;}
test('closed registration, private access and CSRF/origin checks',async()=>{
 await request(app).post('/api/auth/register').send({name:'Bad',email:'bad@example.test',password:'long-password-untrusted'}).expect(403);
 await request(app).get(`/api/vaults/${vaultId}/files`).expect(401);
 await outsider.get(`/api/vaults/${vaultId}/files`).expect(403);
 await owner.post('/api/vaults').send({}).expect(403);
 await owner.post('/api/vaults').set('X-CSRF-Token',csrf).set('Origin','https://evil.example').send({}).expect(403);
});
test('encrypted private writes persist and never store path/plaintext',async()=>{
 const x=await write(0,'Highly private words 密码');const r=await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x).expect(200);head=r.body.file;
 assert.equal((await decryptFile(head,ring)).content,'Highly private words 密码');
 const raw=JSON.stringify(db.prepare('SELECT * FROM files').all());assert(!raw.includes('Highly private'));assert(!raw.includes('秘密.md'));
 const result=await owner.get(`/api/vaults/${vaultId}/files?after=0`).expect(200);assert.equal(result.body.files.length,1);assert.equal(result.body.cursor,1);
});
test('idempotent retries return same revision; reused id with changed payload fails',async()=>{
 const x=await write(1,'second version');const a=await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x).expect(200),b=await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x).expect(200);assert.deepEqual(a.body,b.body);head=a.body.file;
 await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send({...x,deleted:true}).expect(409);
});
test('concurrent writers cannot overwrite a newer revision',async()=>{
 const [a,b]=await Promise.all([write(2,'writer A'),write(2,'writer B')]);const results=await Promise.all([a,b].map(x=>owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);head=results.find(r=>r.status===200)!.body.file;assert.equal(results.find(r=>r.status===409)!.body.file.revision,3);
 const h=await owner.get(`/api/vaults/${vaultId}/files/${fileId}/history`).expect(200);assert.equal(h.body.files.length,3);
});
test('deletion is a versioned tombstone; restoring history creates a new version',async()=>{
 const x=await write(3,'deleted');x.deleted=true;x.box=await encryptFile(vaultId,fileId,4,true,{path:'Private/秘密.md',content:'deleted'},ring);
 const r=await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x).expect(200);assert(r.body.file.deleted);
 const y=await write(4,'restored');head=(await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(y).expect(200)).body.file;
 assert.equal(head.revision,5);assert(!head.deleted);
});
test('encrypted chunk storage is immutable and scoped to vault access',async()=>{
 const id=randomUUID(),bytes=Buffer.from(await encryptChunk(vaultId,id,new TextEncoder().encode('Private attachment'),ring));
 await owner.put(`/api/vaults/${vaultId}/chunks/${id}`).set('X-CSRF-Token',csrf).type('application/octet-stream').send(bytes).expect(201);
 await owner.put(`/api/vaults/${vaultId}/chunks/${id}`).set('X-CSRF-Token',csrf).type('application/octet-stream').send(bytes).expect(200);
 await owner.put(`/api/vaults/${vaultId}/chunks/${id}`).set('X-CSRF-Token',csrf).type('application/octet-stream').send(Buffer.alloc(50)).expect(409);
 await outsider.get(`/api/vaults/${vaultId}/chunks/${id}`).expect(403);await request(app).get(`/api/vaults/${vaultId}/chunks/${id}`).expect(401);
 assert(!readFileSync(join(dir,'chunks',vaultId,id)).includes(Buffer.from('Private attachment')));
});
test('invites grant read-only access and cannot be claimed by another user',async()=>{
 const i=await owner.post(`/api/vaults/${vaultId}/invites`).set('X-CSRF-Token',csrf).send({role:'viewer'}).expect(200);
 const r=await viewer.post('/api/auth/register').send({name:'Reader',email:'reader@example.test',password:'reader-account-password',invite:i.body.token}).expect(201);viewerCsrf=r.body.csrf;viewerId=r.body.user.id;
 await viewer.get(`/api/vaults/${vaultId}/files`).expect(200);
 await viewer.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',viewerCsrf).send(await write(5,'forbidden')).expect(403);
 await viewer.post(`/api/vaults/${vaultId}/sites`).set('X-CSRF-Token',viewerCsrf).send({slug:'not-allowed',title:'No'}).expect(403);
 const me=await outsider.get('/api/auth/me');await outsider.post(`/api/invites/${i.body.token}/accept`).set('X-CSRF-Token',me.body.csrf).expect(404);
});
test('device tokens are vault-scoped, cannot publish and can be revoked',async()=>{
 const d=await owner.post('/api/devices').set('X-CSRF-Token',csrf).send({name:'Mac helper',vaultId}).expect(201);
 await request(app).get(`/api/vaults/${vaultId}/files`).auth(d.body.token,{type:'bearer'}).expect(200);
 await request(app).post(`/api/vaults/${vaultId}/sites`).auth(d.body.token,{type:'bearer'}).send({slug:'forbidden-device',title:'No'}).expect(403);
 await owner.delete(`/api/devices/${d.body.id}`).set('X-CSRF-Token',csrf).expect(200);
 await request(app).get(`/api/vaults/${vaultId}/files`).auth(d.body.token,{type:'bearer'}).expect(401);
});
test('key rotation atomically revokes member and rejects stale writes while preserving history',async()=>{
 const oldRing=ring,rotated=await rotateVaultCrypto(vaultId,ring,'new distinct unlock phrase');
 await owner.post(`/api/vaults/${vaultId}/rotate`).set('X-CSRF-Token',csrf).send({expectedEpoch:1,epoch:2,salt:rotated.salt,keyBox:rotated.keyBox,revokeUserId:viewerId}).expect(200);
 await viewer.get(`/api/vaults/${vaultId}/files`).expect(403);
 await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(await write(5,'stale encryption')).expect(412);
 ring=rotated.keyring;assert.equal((await decryptFile(head,ring)).content,'restored');
 const x=await write(5,'new epoch private');const r=await owner.put(`/api/vaults/${vaultId}/files/${fileId}`).set('X-CSRF-Token',csrf).send(x).expect(200);
 await assert.rejects(()=>decryptFile(r.body.file,oldRing));
});
test('publication isolates private data, protects all assets and honors unpublish',async()=>{
 const s=await owner.post(`/api/vaults/${vaultId}/sites`).set('X-CSRF-Token',csrf).send({slug:'public-garden',title:'Garden'}).expect(201),sid=s.body.site.id,nid=randomUUID(),aid=randomUUID();
 const input={expectedRevision:0,title:'Garden',description:'Selected notes',theme:'light',accent:'#aa8833',noindex:false,notes:[{id:nid,path:'Public.md',content:'Public words [[Private/秘密]]',title:'Public',slug:'public',updatedAt:new Date().toISOString()}],assets:[{id:aid,path:'cover.png',mime:'image/png',data:Buffer.from('image-fixture').toString('base64')}]};
 await request(app).get('/api/published/public-garden').expect(404);
 await owner.put(`/api/sites/${sid}`).set('X-CSRF-Token',csrf).send(input).expect(200);
 const pub=await request(app).get('/api/published/public-garden').expect(200);assert(!JSON.stringify(pub.body).includes('秘密'));assert(!JSON.stringify(pub.body).includes(vaultId));assert.equal(pub.body.notes.length,1);
 await owner.put(`/api/sites/${sid}`).set('X-CSRF-Token',csrf).send(input).expect(409);
 await request(app).get(`/api/published/public-garden/assets/${aid}`).expect(200);
 await owner.put(`/api/sites/${sid}`).set('X-CSRF-Token',csrf).send({...input,expectedRevision:1,password:'private-site-password'}).expect(200);
 await request(app).get('/api/published/public-garden').expect(401);await request(app).get(`/api/published/public-garden/assets/${aid}`).expect(401);
 const reader=request.agent(app);await reader.post('/api/published/public-garden/unlock').send({password:'private-site-password'}).expect(200);await reader.get('/api/published/public-garden').expect(200);
 const sitemap=await request(app).get('/sitemap.xml');assert(!sitemap.text.includes('public-garden'));
 await owner.delete(`/api/sites/${sid}/publication`).set('X-CSRF-Token',csrf).expect(200);await reader.get('/api/published/public-garden').expect(404);await reader.get(`/api/published/public-garden/assets/${aid}`).expect(404);
});
