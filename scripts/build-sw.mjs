import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'dist');
const html=await readFile(path.join(dist,'index.html'),'utf8');
const assets=[];
async function walk(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const full=path.join(directory,entry.name);
  if(entry.isDirectory())await walk(full);
  else if(/\.(?:js|css|woff2?|ttf|otf)$/i.test(entry.name))assets.push('/'+path.relative(dist,full).split(path.sep).join('/'));
 }
}
await walk(path.join(dist,'assets'));
const manifest=['/','/flint.svg','/manifest.webmanifest',...assets.sort()];
const hash=createHash('sha256').update(html).update(JSON.stringify(manifest)).digest('hex').slice(0,16);
const template=await readFile(path.join(root,'public/sw.js'),'utf8');
const worker=template.replace("const CACHE='flint-shell-development';",`const CACHE='flint-shell-${hash}';`).replace("const PRECACHE=['/','/flint.svg','/manifest.webmanifest'];",`const PRECACHE=${JSON.stringify(manifest)};`);
await writeFile(path.join(dist,'sw.js'),worker);
console.log(`Generated offline shell ${hash}: ${manifest.length} resources.`);
