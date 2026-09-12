import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import {createApp} from '../server/app';
import {hashPassword} from '../server/security';

async function fixture(quotaBytes=100_000,staticPage=false){
 const directory=mkdtempSync(join(tmpdir(),'flint-review-test-'));
 const staticDir=staticPage?join(directory,'web'):undefined;
 if(staticDir){mkdirSync(staticDir);writeFileSync(join(staticDir,'index.html'),'<!doctype html><html><head><title>Flint</title></head><body><div id="root"></div></body></html>');}
 const {app,db}=createApp({dataDir:directory,origin:'http://localhost:5191',bootstrapCode:'review-test-registration',disableRateLimit:true,quotaBytes,staticDir});
 const owner=request.agent(app);
 const account=await owner.post('/api/auth/register').send({name:'Owner',email:'owner@example.test',password:'account-test-password',code:'review-test-registration'}).expect(201);
 const csrf=account.body.csrf as string,vaultId=randomUUID();
 await owner.post('/api/vaults').set('X-CSRF-Token',csrf).send({id:vaultId,name:'Test',salt:'a-long-unique-salt-value',keyBox:{iv:Buffer.alloc(12).toString('base64'),data:Buffer.alloc(30).toString('base64')}}).expect(201);
 return {app,db,owner,csrf,vaultId,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
function publication(content='Visible note',assetSize=20){return {expectedRevision:0,title:'Test site',description:'Selected notes',theme:'light',accent:'#112233',noindex:true,notes:[{id:randomUUID(),path:'test.md',title:'Test note',slug:'test',content,updatedAt:new Date().toISOString()}],assets:[{id:randomUUID(),path:'sample.txt',mime:'text/plain',data:Buffer.alloc(assetSize).toString('base64')}]};}

test('revocation invalidates a previously consumed invitation',async()=>{
 const f=await fixture();
 try{
  const invitation=await f.owner.post(`/api/vaults/${f.vaultId}/invites`).set('X-CSRF-Token',f.csrf).send({role:'editor'}).expect(200);
  const member=request.agent(f.app);
  const account=await member.post('/api/auth/register').send({name:'Member',email:'member@example.test',password:'member-test-password',invite:invitation.body.token}).expect(201);
  await member.post(`/api/invites/${invitation.body.token}/accept`).set('X-CSRF-Token',account.body.csrf).expect(200);
  await f.owner.delete(`/api/vaults/${f.vaultId}/members/${account.body.user.id}`).set('X-CSRF-Token',f.csrf).expect(200);
  await member.get(`/api/vaults/${f.vaultId}/files`).expect(403);
  await member.post(`/api/invites/${invitation.body.token}/accept`).set('X-CSRF-Token',account.body.csrf).expect(404);
  await member.get(`/api/vaults/${f.vaultId}/files`).expect(403);
 }finally{f.close();}
});

test('publication quota includes plaintext notes and binary assets and preserves prior snapshot on failure',async()=>{
 const f=await fixture(400);
 try{
  const created=await f.owner.post(`/api/vaults/${f.vaultId}/sites`).set('X-CSRF-Token',f.csrf).send({slug:'quota-site',title:'Test'}).expect(201);
  const siteId=created.body.site.id,input=publication('Visible note',100);
  await f.owner.put(`/api/sites/${siteId}`).set('X-CSRF-Token',f.csrf).send(input).expect(200);
  const usage=await f.owner.get(`/api/vaults/${f.vaultId}/usage`).expect(200);
  assert.equal(usage.body.bytes,Buffer.byteLength(input.notes[0].content)+100);
  await f.owner.put(`/api/sites/${siteId}`).set('X-CSRF-Token',f.csrf).send({...publication('x'.repeat(2000),2000),expectedRevision:1}).expect(413);
  const current=await request(f.app).get('/api/published/quota-site').expect(200);
  assert.equal(current.body.notes[0].content,input.notes[0].content);
  assert.equal(current.body.site.revision,1);
  await f.owner.delete(`/api/sites/${siteId}/publication`).set('X-CSRF-Token',f.csrf).expect(200);
  assert.equal((await f.owner.get(`/api/vaults/${f.vaultId}/usage`)).body.bytes,0);
 }finally{f.close();}
});

for(const change of ['password','unpublish'] as const)test(`in-flight public unlock cannot survive ${change}`,async()=>{
 const f=await fixture();
 try{
  const created=await f.owner.post(`/api/vaults/${f.vaultId}/sites`).set('X-CSRF-Token',f.csrf).send({slug:'protected-site',title:'Test'}).expect(201);
  const siteId=created.body.site.id;
  await f.owner.put(`/api/sites/${siteId}`).set('X-CSRF-Token',f.csrf).send({...publication(),password:'original-site-password'}).expect(200);
  const replacement=await hashPassword('replacement-site-password');
  const original=f.db.prepare.bind(f.db);let injected=false;
  // Force a concurrent committed change after the old hash is read but before
  // asynchronous scrypt finishes. No production code is replaced.
  f.db.prepare=((sql:string)=>{const statement=original(sql);if(sql==='SELECT * FROM sites WHERE slug=? AND published=1'&&!injected){const get=statement.get.bind(statement);statement.get=((...args:any[])=>{const row=get(...args);injected=true;queueMicrotask(()=>{
   if(change==='password')original('UPDATE sites SET password_hash=?,revision=revision+1 WHERE id=?').run(replacement,siteId);
   else original('UPDATE sites SET published=0,revision=revision+1 WHERE id=?').run(siteId);
   original('DELETE FROM public_sessions WHERE site_id=?').run(siteId);
  });return row;}) as typeof statement.get;}return statement;}) as typeof f.db.prepare;
  const visitor=request.agent(f.app);
  const unlocked=await visitor.post('/api/published/protected-site/unlock').send({password:'original-site-password'});
  assert.equal(injected,true);assert.equal(unlocked.status,change==='password'?401:404);
  assert.equal((original('SELECT count(*) n FROM public_sessions').get() as any).n,0);
  await visitor.get('/api/published/protected-site').expect(change==='password'?401:404);
  f.db.prepare=original;
 }finally{f.close();}
});

test('encrypted manifests are bounded, paginated without content, and counted with replay storage',async()=>{
 const f=await fixture();
 try{
  const id=randomUUID(),contentBox={iv:Buffer.alloc(12).toString('base64'),data:Buffer.alloc(30).toString('base64')};
  const input={id,baseRevision:0,epoch:1,deleted:false,mutationId:randomUUID(),box:contentBox,manifestBox:{iv:contentBox.iv,data:Buffer.alloc(6144).toString('base64')}};
  assert.equal(input.manifestBox.data.length,8192);
  await f.owner.put(`/api/vaults/${f.vaultId}/files/${id}`).set('X-CSRF-Token',f.csrf).send({...input,manifestBox:{...input.manifestBox,data:Buffer.alloc(6145).toString('base64')}}).expect(400);
  const written=await f.owner.put(`/api/vaults/${f.vaultId}/files/${id}`).set('X-CSRF-Token',f.csrf).send(input).expect(200);
  const actual=(await f.owner.get(`/api/vaults/${f.vaultId}/usage`).expect(200)).body.bytes;
  assert.equal(actual,JSON.stringify(contentBox).length*2+JSON.stringify(input.manifestBox).length+JSON.stringify(written.body).length);
  const manifests=await f.owner.get(`/api/vaults/${f.vaultId}/manifests?after=0`).expect(200);
  assert.equal(manifests.body.files.length,1);assert.equal(manifests.body.files[0].box,undefined);assert.deepEqual(manifests.body.files[0].manifestBox,input.manifestBox);
  await request(f.app).get(`/api/vaults/${f.vaultId}/manifests`).expect(401);
  const full=await f.owner.get(`/api/vaults/${f.vaultId}/files/${id}?revision=1`).expect(200);assert.deepEqual(full.body.file.box,contentBox);
 }finally{f.close();}
});

test('manifest and replay bytes cannot bypass the quota of a small content write',async()=>{
 const f=await fixture(1000);
 try{
  const id=randomUUID(),iv=Buffer.alloc(12).toString('base64');
  await f.owner.put(`/api/vaults/${f.vaultId}/files/${id}`).set('X-CSRF-Token',f.csrf).send({id,baseRevision:0,epoch:1,deleted:false,mutationId:randomUUID(),box:{iv,data:Buffer.alloc(30).toString('base64')},manifestBox:{iv,data:Buffer.alloc(600).toString('base64')}}).expect(413);
  assert.equal((f.db.prepare('SELECT count(*) n FROM files').get() as any).n,0);
  assert.equal((f.db.prepare('SELECT count(*) n FROM mutations').get() as any).n,0);
  assert.equal((await f.owner.get(`/api/vaults/${f.vaultId}/usage`)).body.bytes,0);
 }finally{f.close();}
});

test('Unicode publication slugs resolve on direct navigation and sitemap URLs are encoded',async()=>{
 const f=await fixture(100_000,true);
 try{
  const created=await f.owner.post(`/api/vaults/${f.vaultId}/sites`).set('X-CSRF-Token',f.csrf).send({slug:'unicode-site',title:'Test'}).expect(201);
  const siteId=created.body.site.id,input=publication();input.noindex=false;input.notes[0].slug='中文-笔记';input.notes[0].title='中文笔记';
  await f.owner.put(`/api/sites/${siteId}`).set('X-CSRF-Token',f.csrf).send(input).expect(200);
  const path='/p/unicode-site/'+encodeURIComponent(input.notes[0].slug);
  const page=await request(f.app).get(path).expect(200);
  assert(page.text.includes('<title>中文笔记 · Test site</title>'));
  assert(page.text.includes('href="http://localhost:5191'+path+'"'));
  assert.equal(page.headers['cache-control'],'no-store');
  const sitemap=await request(f.app).get('/sitemap.xml').expect(200);assert(sitemap.text.includes(path));
  await request(f.app).get('/p/unicode-site/'+encodeURIComponent('不存在')).expect(404);
 }finally{f.close();}
});
