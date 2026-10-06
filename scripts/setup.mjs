import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22 || major===22 && minor<13)throw new Error('Node.js 22.13+ is required.');
function runNpm(args){const result=process.platform==='win32'?spawnSync('cmd.exe',['/d','/s','/c',`npm ${args.join(' ')}`],{cwd:root,stdio:'inherit',windowsHide:true}):spawnSync('npm',args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
if(!existsSync(path.join(root,'node_modules','vinext')))runNpm(['ci']);
runNpm(['run','build']);
const result=spawnSync(process.execPath,[path.join(root,'node_modules','playwright','cli.js'),'install','chromium'],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.status!==0)console.warn('Preview browser installation failed. Retry: npx playwright install chromium');
console.log('ViiOS is ready. Run npm start, then open http://127.0.0.1:3180.');
