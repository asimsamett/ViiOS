import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalog=JSON.parse(readFileSync(new URL('./projects.json',import.meta.url),'utf8'));
const within=(directory,root)=>directory===root || directory.startsWith(root+'/');
const meaningful=directory=>typeof directory==='string' && directory.startsWith('/') && !['/','/root','/home','/opt','/srv'].includes(directory) && !/^\/(etc|usr|run|proc|sys|var\/lib)(\/|$)/.test(directory) && !directory.split('/').some(part=>['.','..','.ssh','.gnupg'].includes(part));
function matchesService(app,service,rootMatch) {
  if(app.port!==service.port)return false;
  if(service.unit)return app.control?.unit===service.unit;
  if(service.container)return app.control?.kind==='container' && app.control?.label===service.container;
  return rootMatch;
}

// Identity comes from working directories or verified unit/container names,
// never from a reused port number alone. Enrichment does not alter saved events.
export function projectApps(apps,{id='',host='',catalog:configured=catalog}={}) {
  const definitions=configured.filter(project=>(!project.serverId || project.serverId===id) && (!project.host || project.host===host));
  function projectInfo(project,seen=new Set()){
    const info={id:project.id,name:project.name,directory:project.directory,primaryPort:project.primaryPort,system:false};
    seen.add(project.id);
    const parent=definitions.find(candidate=>candidate.id===project.parentId);
    if(parent && !seen.has(parent.id)){
      info.parent=projectInfo(parent,seen);
      info.relationship={kind:'configured',label:project.relationship?.label || 'Bağlı alt proje',description:project.relationship?.description || `${parent.name} projesine bağlıdır.`};
    }
    return info;
  }
  const enriched=apps.map(app=>{
    const directory=typeof app.directory==='string'?app.directory.replace(/\/+$/,''):'';
    const candidates=definitions.map(project=>{
      const root=(project.roots || []).filter(root=>within(directory,root)).sort((a,b)=>b.length-a.length)[0];
      const service=(project.services || []).find(service=>matchesService(app,service,!!root));
      return {project,root,service};
    }).filter(match=>match.root || match.service).sort((a,b)=>(b.root?.length || 0)-(a.root?.length || 0));
    const match=candidates[0];
    if(match){
      const {project,service}=match;
      return {...app,project:projectInfo(project),serviceName:service?.name || app.name,filesPath:service?.directory || (meaningful(directory)?directory:project.directory)};
    }
    if(meaningful(directory)){
      const candidate=directory.replace(/\/(app|src|backend|frontend|service|server|client|api)$/,'');
      const root=meaningful(candidate)?candidate:directory;
      return {...app,project:{id:`directory:${root}`,name:'',directory:root,system:false},serviceName:app.name,filesPath:directory};
    }
    const system=app.process!=='docker-proxy' && (directory || /^(sshd|systemd|avahi|cupsd)/.test(app.process || ''));
    return {...app,project:{id:system?'system-services':`port:${app.port}`,name:system?'Sistem Servisleri':app.name,directory:null,system:!!system},serviceName:app.name,filesPath:null};
  });
  const names=new Map();
  for(const app of [...enriched].sort((a,b)=>Number(b.kind==='web')-Number(a.kind==='web') || Number(a.active===false)-Number(b.active===false) || a.port-b.port)){
    if(!app.project.name && !names.has(app.project.id)){
      const name=app.originalName || app.name || path.posix.basename(app.project.directory || '').replace(/[-_]/g,' ') || app.process || `Servis ${app.port}`;
      names.set(app.project.id,name);
    }
  }
  return enriched.map(app=>({...app,project:{...app.project,name:app.project.name || names.get(app.project.id)}}));
}
