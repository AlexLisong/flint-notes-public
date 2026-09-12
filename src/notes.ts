import type {LocalFile} from '../shared/types';
export const basename=(path:string)=>path.split('/').pop()||path;
export const noteTitle=(path:string)=>basename(path).replace(/\.(md|canvas)$/i,'');
export const slugify=(s:string)=>s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'')||'note';
export const isNote=(p:string)=>/\.md$/i.test(p);
export function cleanPath(path:string){const p=path.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');if(!p||p.split('/').some(x=>x==='..'||!x)||p.includes('\0'))throw new Error('Use a valid relative file path.');return p;}
export function resolveLink(target:string,source:string,files:LocalFile[]){const clean=decodeURIComponent(target.split('#')[0].split('|')[0]);if(!clean)return files.find(f=>!f.deleted&&f.path===source);const normalized=clean.replace(/^\.\//,'');const parent=source.includes('/')?source.slice(0,source.lastIndexOf('/')+1):'';const paths=[normalized,parent+normalized];const exact=files.find(f=>!f.deleted&&paths.some(p=>f.path===p||f.path===p+'.md'));if(exact)return exact;const matching=files.filter(f=>!f.deleted&&(basename(f.path)===clean||noteTitle(f.path)===clean));return matching.length===1?matching[0]:undefined;}
export function links(content:string){return [...content.matchAll(/!?\[\[([^\]]+)\]\]/g)].map(m=>m[1].split('|')[0]);}
export function backlinks(file:LocalFile,files:LocalFile[]){return files.filter(f=>!f.deleted&&f.id!==file.id&&links(f.content).some(l=>resolveLink(l,f.path,files)?.id===file.id));}
export function headings(content:string){return [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(m=>({level:m[1].length,title:m[2],id:slugify(m[2])}));}
export function frontmatter(content:string){const m=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);return m?{raw:m[1],body:content.slice(m[0].length)}:{raw:'',body:content};}
export function rewriteLinks(content:string,source:string,oldPath:string,newPath:string,files:LocalFile[]){return content.replace(/(!?)\[\[([^\]]+)\]\]/g,(whole,embed,inside)=>{const [ref,...alias]=inside.split('|');const [target,...anchor]=ref.split('#');if(resolveLink(target,source,files)?.path!==oldPath)return whole;return `${embed}[[${newPath.replace(/\.md$/i,'')}${anchor.length?'#'+anchor.join('#'):''}${alias.length?'|'+alias.join('|'):''}]]`;});}
