import type { App, ProjectInfo } from './types';

export type ProjectGroup=ProjectInfo & {apps:App[];directApps:App[];children:ProjectGroup[]};
export type ProjectService={id:string;name:string;apps:App[]};
export type ProjectFolder={id:string;name:string;directory:string|null;services:ProjectService[]};
export const endpointIssue=(app:App)=>app.active===false?!!app.annotation?.expectedUp:app.networkState==='unknown' || app.httpApplicable!==false && (!app.status || app.status>=500);
const projectOrder=(a:ProjectGroup,b:ProjectGroup)=>Number(a.system)-Number(b.system) || a.name.localeCompare(b.name,'tr');
const folderPath=(value?:string|null)=>value?.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..') ? '/'+value.split('/').filter(part=>part && part!=='.').join('/') : null;
const within=(child:string,root:string)=>child.startsWith(root+'/');
const sharedRoots=new Set(['/','/home','/root','/opt','/srv','/var','/var/www','/tmp']);
const isSharedRoot=(root:string)=>sharedRoots.has(root) || /^\/[a-z]:(?:\/(?:Users|Program Files|Program Files \(x86\)|ProgramData))?$/i.test(root);

/** Keep project identities intact. Only the display tree aggregates descendants. */
export function groupProjects(apps:App[]):ProjectGroup[]{
  const groups=new Map<string,ProjectGroup>();
  function ensure(info:ProjectInfo,seen=new Set<string>()){
    if(seen.has(info.id))return;
    seen.add(info.id);
    if(!groups.has(info.id))groups.set(info.id,{...info,apps:[],directApps:[],children:[]});
    if(info.parent && seen.size<32)ensure(info.parent,seen);
  }
  for(const app of apps){
    const info=app.project || {id:`port:${app.port}`,name:app.name,directory:app.directory || null,system:false};
    ensure(info);
    const group=groups.get(info.id)!;
    Object.assign(group,info);
    group.directApps.push(app);
  }
  const parents=new Map<string,string>();
  for(const project of groups.values()){
    if(project.system)continue;
    if(project.parent){
      const parent=groups.get(project.parent.id);
      if(parent && parent.id!==project.id && !parent.system)parents.set(project.id,parent.id);
      continue;
    }
    const directory=folderPath(project.directory);
    if(!directory)continue;
    const candidates=[...groups.values()].filter(candidate=>{
      const root=folderPath(candidate.directory);
      return !candidate.system && candidate.id!==project.id && root && !isSharedRoot(root) && within(directory,root);
    }).sort((a,b)=>folderPath(b.directory)!.length-folderPath(a.directory)!.length);
    const nearest=candidates[0];
    // Identical/ambiguous roots do not establish ownership. A common workspace
    // or similar name/port is also not evidence of a parent project.
    if(nearest && (!candidates[1] || folderPath(nearest.directory)!==folderPath(candidates[1].directory))){
      parents.set(project.id,nearest.id);
      project.relationship={kind:'directory',label:'Alt klasör',description:`${nearest.name} proje klasörünün içinde yer alır.`};
    }
  }
  const cyclic=new Set<string>();
  for(const id of parents.keys()){
    const chain:string[]=[];
    let cursor:string|undefined=id;
    while(cursor && parents.has(cursor)){
      const repeated=chain.indexOf(cursor);
      if(repeated>=0){for(const member of chain.slice(repeated))cyclic.add(member);break;}
      chain.push(cursor);cursor=parents.get(cursor);
    }
  }
  for(const id of cyclic)parents.delete(id);
  const roots:ProjectGroup[]=[];
  for(const project of groups.values()){
    const parent=parents.get(project.id);
    if(parent)groups.get(parent)!.children.push(project);else roots.push(project);
  }
  function collect(project:ProjectGroup):App[]{
    project.directApps.sort((a,b)=>a.port-b.port);
    project.children.sort(projectOrder);
    project.apps=[...project.directApps,...project.children.flatMap(collect)].sort((a,b)=>a.port-b.port);
    return project.apps;
  }
  roots.forEach(collect);
  return roots.sort(projectOrder);
}
export function flattenProjects(projects:ProjectGroup[]):ProjectGroup[]{
  return projects.flatMap(project=>[project,...flattenProjects(project.children)]);
}
export function projectTrail(projects:ProjectGroup[],id:string):ProjectGroup[]{
  for(const project of projects){
    if(project.id===id)return [project];
    const trail=projectTrail(project.children,id);
    if(trail.length)return [project,...trail];
  }
  return [];
}
export function groupServices(project:Pick<ProjectGroup,'apps'|'primaryPort'>):ProjectService[]{
  const groups=new Map<string,ProjectService>();
  for(const app of project.apps){
    const control=app.control;
    const id=control?.unit?`unit:${control.unit}`:control?.kind==='container' && control.label?`container:${control.label}`:app.pid && app.active!==false?`pid:${app.pid}`:`port:${app.port}`;
    if(!groups.has(id))groups.set(id,{id,name:app.serviceName || app.name,apps:[]});
    groups.get(id)!.apps.push(app);
  }
  return [...groups.values()].sort((a,b)=>Number(b.apps.some(app=>app.port===project.primaryPort))-Number(a.apps.some(app=>app.port===project.primaryPort)) || a.apps[0].port-b.apps[0].port);
}

/** One service appears once, even when its listeners report different folders. */
export function groupFolders(project:ProjectGroup):ProjectFolder[]{
  const folders=new Map<string,ProjectFolder>();
  for(const service of groupServices({apps:project.directApps,primaryPort:project.primaryPort})){
    const paths=[...new Set(service.apps.map(app=>folderPath(app.filesPath)).filter((item):item is string=>!!item))];
    let directory=paths[0] || null;
    if(paths.length>1){
      const parts=paths[0].split('/');
      while(parts.length>1 && !paths.every(path=>path===parts.join('/') || within(path,parts.join('/'))))parts.pop();
      directory=parts.length>1?parts.join('/'):null;
    }
    const root=folderPath(project.directory),id=directory || 'unresolved';
    const name=!directory?'Klasör belirlenemedi':directory===root?'Proje kökü':root && within(directory,root)?directory.slice(root.length+1):directory.split('/').at(-1)!;
    if(!folders.has(id))folders.set(id,{id,name,directory,services:[]});
    folders.get(id)!.services.push(service);
  }
  return [...folders.values()].sort((a,b)=>Number(b.services.some(service=>service.apps.some(app=>app.port===project.primaryPort)))-Number(a.services.some(service=>service.apps.some(app=>app.port===project.primaryPort))) || a.name.localeCompare(b.name,'tr'));
}
