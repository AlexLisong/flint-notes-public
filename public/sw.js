/* The production build replaces these two constants with a release hash and
   the emitted JavaScript/CSS/font manifest, so first offline reload is usable. */
const CACHE='flint-shell-development';
const PRECACHE=['/','/flint.svg','/manifest.webmanifest'];
const isPrivateApiOrPublished=pathname=>pathname==='/api'||pathname.startsWith('/api/')||pathname==='/p'||pathname.startsWith('/p/');
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PRECACHE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('flint-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin||request.method!=='GET'||isPrivateApiOrPublished(url.pathname))return;
 if(request.mode==='navigate'){
  event.respondWith((async()=>{
   try{
    const response=await fetch(request);
    if(response.ok&&(response.headers.get('Content-Type')||'').includes('text/html')){
     const copy=response.clone();
     event.waitUntil(caches.open(CACHE).then(cache=>cache.put('/',copy)));
    }
    return response;
   }catch{
    const cached=await caches.match('/',{cacheName:CACHE});
    return cached||new Response('Flint is offline. Connect once to download the workspace.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
   }
  })());
  return;
 }
 if(url.pathname.startsWith('/assets/')||PRECACHE.includes(url.pathname)){
  event.respondWith((async()=>{
   const cache=await caches.open(CACHE);
   const cached=await cache.match(request);
   if(cached)return cached;
   const response=await fetch(request);
   if(response.ok){const copy=response.clone();event.waitUntil(cache.put(request,copy));}
   return response;
  })());
 }
});
