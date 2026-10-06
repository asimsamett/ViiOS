import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {hashPassword} from './auth.mjs';
import {securePrivateDirectory,privatePermissions} from './connection-store.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function createAdminSetup({dataDir,onConfigured=async()=>{}}){
 await securePrivateDirectory(dataDir);const filename=path.join(dataDir,'admin.json');let configured,pending=false;
 try{configured=JSON.parse(await readFile(filename,'utf8'));if(!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(configured.passwordHash||''))throw fail('Yönetici yapılandırması geçersiz.',503);}catch(e){if(e.code!=='ENOENT')throw e;}
 return {status:()=>({required:!configured}),passwordHash:()=>configured?.passwordHash||null,async configure(input){
  if(configured||pending)throw fail('İlk kurulum zaten tamamlandı veya sürüyor.',409);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['password','confirmPassword'].includes(k)))throw fail('Geçersiz kurulum isteği.');
  if(typeof input.password!=='string'||input.password.length<8||input.password.length>256||input.password!==input.confirmPassword)throw fail('Eşleşen, en az 8 karakterli bir yönetici şifresi girin.');
  pending=true;try{const next={passwordHash:hashPassword(input.password),createdAt:new Date().toISOString()};await writeFile(filename,JSON.stringify(next),{flag:'wx',mode:0o600});await privatePermissions(filename);configured=next;await onConfigured(next.passwordHash);return {configured:true};}finally{pending=false;}
 }};
}
