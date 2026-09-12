export type Box={iv:string;data:string};
export type Role='owner'|'editor'|'viewer';
export interface Vault {id:string;name:string;salt:string;keyBox:Box;epoch:number;role:Role;createdAt:string}
export interface Attachment {mime:string;size:number;chunks:string[];epoch:number}
export interface FileData {path:string;content:string;attachment?:Attachment}
export interface FileRecord {id:string;vaultId:string;revision:number;epoch:number;box:Box;manifestBox?:Box;deleted:boolean;updatedAt:string;seq:number}
export type FileManifest=Omit<FileRecord,'box'>;
export interface LocalFile extends FileData {id:string;revision:number;deleted:boolean;updatedAt:string;pending?:boolean;conflict?:boolean}
export interface FileWrite {id:string;baseRevision:number;epoch:number;box:Box;manifestBox?:Box;deleted:boolean;mutationId:string}
export interface ChangePage {files:FileRecord[];cursor:number;hasMore:boolean}
export interface User {id:string;email:string;name:string}
export interface Session {user:User;csrf:string}
export interface Site {id:string;vaultId:string;slug:string;title:string;description:string;theme:'light'|'dark';accent:string;passwordProtected:boolean;noindex:boolean;updatedAt:string;revision:number}
export interface PublishedNote {id:string;path:string;content:string;title:string;slug:string;updatedAt:string}
export interface PublishInput {expectedRevision:number;title:string;description:string;theme:'light'|'dark';accent:string;noindex:boolean;password?:string;removePassword?:boolean;notes:PublishedNote[];assets:{id:string;path:string;mime:string;data:string}[]}
