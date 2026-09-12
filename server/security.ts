import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {z} from 'zod';
const derive=promisify(scrypt);
export const uuid=z.uuid();
export const now=()=>new Date().toISOString();
export const token=()=>randomBytes(32).toString('base64url');
export const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function hashPassword(value:string){const salt=token();const key=await derive(value,salt,64) as Buffer;return `${salt}:${key.toString('hex')}`;}
export async function verifyPassword(value:string,stored:string){const [salt,hex]=stored.split(':');if(!salt||!hex)return false;return equal((await derive(value,salt,64) as Buffer).toString('hex'),hex);}
export class HttpError extends Error {constructor(public status:number,message:string,public code?:string,public details?:object){super(message);}}
export function fail(status:number,message:string,code?:string,details?:object):never{throw new HttpError(status,message,code,details);}
export const box=z.object({iv:z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).length(16),data:z.string().min(24).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
export function safePath(p:string){return p.length>0&&p.length<=1000&&!p.startsWith('/')&&!p.includes('\\')&&!/[\u0000-\u001f]/.test(p)&&!p.split('/').some(s=>!s||s==='.'||s==='..')&&!/^[a-zA-Z]:/.test(p);}
export function html(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
