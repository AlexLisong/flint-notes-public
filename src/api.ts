import type { Session } from '../shared/types';
let csrf='';
export function setSession(s:Session|null){csrf=s?.csrf||'';}
export class ApiError extends Error{constructor(public status:number,public body:any){super(body.error||`Request failed (${status})`);}}
export async function api<T=any>(path:string,init:RequestInit={}):Promise<T>{
 const res=await fetch(`/api${path}`,{...init,headers:{...(init.body&&!(init.body instanceof Uint8Array)?{'Content-Type':'application/json'}:{}),'X-CSRF-Token':csrf,...init.headers}});
 if(!res.ok){let b;try{b=await res.json();}catch{b={error:res.statusText};}throw new ApiError(res.status,b);}
 return res.status===204?undefined as T:res.json();
}
export const post=<T=any>(p:string,b:any={})=>api<T>(p,{method:'POST',body:JSON.stringify(b)});
export async function getBytes(path:string){const r=await fetch(`/api${path}`);if(!r.ok)throw new Error('Attachment download failed');return new Uint8Array(await r.arrayBuffer());}
export function download(name:string,data:BlobPart,type='application/octet-stream'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
