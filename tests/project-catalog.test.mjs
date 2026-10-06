import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { projectApps as enrichProjectApps } from '../server/project-catalog.mjs';

// Keep configured relationships in a synthetic test catalogue, never in the distribution.
const primary = { id: 'srv-111111111111111111111111', host: '192.0.2.10' };
const fixtureCatalog = [
  { id: 'example-suite', name: 'Example Suite', directory: '/home/Example_Suite', roots: ['/home/Example_Suite'], primaryPort: 8011, services: [
    { port: 8011, name: 'Main application', unit: 'example-suite.service', directory: '/home/Example_Suite/app' },
    { port: 8013, name: 'Report service', unit: 'example-suite-report-fetch.service', directory: '/home/Example_Suite/app' },
    { port: 5433, name: 'Database', container: 'example-suite-postgres', directory: '/home/Example_Suite/postgres' },
    { port: 8768, name: 'Model tunnel', unit: 'example-suite-model-tunnel.service', directory: '/home/Example_Suite' },
  ] },
  { id: 'directory:/home/Example_Api', name: 'Example API', directory: '/home/Example_Api', roots: ['/home/Example_Api'], parentId: 'example-suite', services: [{ port: 8800, unit: 'example-api.service', directory: '/home/Example_Api' }] },
  { id: 'data-platform', name: 'Data Platform', directory: '/home/data_platform', roots: ['/home/data_platform'] },
  { id: 'data-worker', name: 'Data Worker', directory: '/home/data_platform/worker', roots: ['/home/data_platform/worker'] },
].map(project => ({ ...project, serverId: primary.id, host: primary.host }));
const projectApps = (apps, target = primary) => enrichProjectApps(apps, { ...target, catalog: fixtureCatalog });

const source=stripTypeScriptTypes(readFileSync(new URL('../app/project-model.ts',import.meta.url),'utf8'));
const {groupProjects,groupServices,groupFolders,flattenProjects,projectTrail}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const endpoint=(port,extra={})=>({port,name:`Servis ${port}`,process:'python3',directory:'',kind:'service',active:true,...extra});
const plan=[
  endpoint(8011,{directory:'/home/Example_Suite/app',name:'Example Suite · Example API',kind:'web',control:{kind:'systemd',unit:'example-suite.service'}}),
  endpoint(8013,{directory:'/home/Example_Suite/app',name:'Example Suite · Rapor Servisi',active:false,control:{kind:'systemd',unit:'example-suite-report-fetch.service'}}),
  endpoint(5433,{directory:'/',process:'docker-proxy',control:{kind:'container',label:'example-suite-postgres'}}),
  endpoint(8768,{directory:'/',process:'ssh',control:{kind:'systemd',unit:'example-suite-model-tunnel.service'}}),
];
const planApi=endpoint(8800,{directory:'/home/Example_Api',name:'Example API — API',kind:'web',control:{kind:'systemd',unit:'example-api.service'}});
const apiId='directory:/home/Example_Api';
const ports=apps=>apps.map(app=>app.port).sort((a,b)=>a-b);
const directPorts=projects=>ports(flattenProjects(projects).flatMap(project=>project.directApps));
const info=(id,directory,extra={})=>({id,name:id,directory,system:false,...extra});
const member=(port,project,extra={})=>endpoint(port,{project,filesPath:project.directory,...extra});

test('Example Suite includes the application, stopped report service, database and model tunnel with their own folders',()=>{
  const original=structuredClone(plan);
  const apps=projectApps(plan),groups=groupProjects(apps);
  assert.deepEqual(plan,original,'Grouping must not change inventory or service settings');
  assert.equal(groups.length,1);assert.equal(groups[0].name,'Example Suite');
  assert.deepEqual(groups[0].apps.map(app=>app.port),[5433,8011,8013,8768]);
  assert.equal(groups[0].primaryPort,8011);
  assert.equal(groupServices(groups[0]).length,4);
  assert.equal(apps.find(app=>app.port===5433).filesPath,'/home/Example_Suite/postgres');
  assert.equal(apps.find(app=>app.port===8013).filesPath,'/home/Example_Suite/app');
  assert.equal(apps.find(app=>app.port===8013).active,false);
  assert.equal(apps.find(app=>app.port===8768).filesPath,'/home/Example_Suite');
});

test('port reuse and another server never inherit a configured project by port alone',()=>{
  const apps=projectApps([endpoint(5433,{directory:'/',process:'docker-proxy',control:{kind:'container',label:'unrelated-db'}}),endpoint(8011,{directory:'/home/another-project',control:{unit:'another.service'}})]);
  assert.ok(apps.every(app=>app.project.id!=='example-suite'));
  const remote=projectApps(plan,{id:'srv-222222222222222222222222',host:'192.0.2.11'});
  assert.ok(remote.every(app=>app.project.id!=='example-suite'));
});

test('specific nested roots take priority and similarly prefixed sibling directories remain separate',()=>{
  const apps=projectApps([endpoint(8020,{directory:'/home/data_platform'}),endpoint(8030,{directory:'/home/data_platform/worker'}),endpoint(8031,{directory:'/home/data_platform-other'})]);
  assert.deepEqual(apps.map(app=>app.project.id),['data-platform','data-worker','directory:/home/data_platform-other']);
});

test('one service can expose multiple ports without duplicate lifecycle controls or lost endpoints',()=>{
  const apps=projectApps([endpoint(8024,{directory:'/srv/projects/notebook',control:{unit:'notebook.service'}}),endpoint(44801,{directory:'/srv/projects/notebook',control:{unit:'notebook.service'}})]);
  const services=groupServices(groupProjects(apps)[0]);
  assert.equal(services.length,1);assert.deepEqual(services[0].apps.map(app=>app.port),[8024,44801]);
});

test('common system directories do not become project source folders and independent processes stay separate',()=>{
  const groups=groupProjects(projectApps([endpoint(22,{process:'sshd',directory:'/'}),endpoint(53,{process:'systemd-resolve',directory:'/'}),endpoint(41001,{process:'systemd-timesyn',directory:'/'})]));
  assert.equal(groups.length,1);assert.equal(groups[0].system,true);
  assert.ok(groups[0].apps.every(app=>app.filesPath===null));
  assert.equal(groupServices(groups[0]).length,3);
});

test('older cached endpoints without a name or directory still have a usable project label',()=>{
  const [app]=projectApps([{port:8097,process:'SSH',directory:'',active:false}]);
  assert.equal(app.project.name,'SSH');assert.equal(app.filesPath,null);
});

test('independent projects with similar titles keep their distinguishing names',()=>{
  const apps=projectApps([endpoint(8096,{directory:'/opt/example-themes/original',name:'Example · Glass'}),endpoint(8098,{directory:'/opt/example-themes/smooth',name:'Example · Smooth'})]);
  assert.deepEqual(groupProjects(apps).map(project=>project.name),['Example · Glass','Example · Smooth']);
});

test('Example API keeps its legacy identity as one child and contributes once to the five-port parent total',()=>{
  const input=[planApi,...plan],original=structuredClone(input);
  const enriched=projectApps(input),before=structuredClone(enriched),roots=groupProjects(enriched);
  assert.deepEqual(input,original);
  assert.deepEqual(enriched,before,'Tree creation must not mutate enriched inventory metadata');
  assert.equal(roots.length,1);
  const parent=roots[0],child=parent.children[0];
  assert.equal(parent.id,'example-suite');assert.equal(parent.children.length,1);
  assert.equal(child.id,apiId);assert.equal(child.parent.id,parent.id);
  assert.equal(child.relationship.kind,'configured');
  assert.equal(child.directory,'/home/Example_Api');
  assert.equal(child.directApps[0].filesPath,'/home/Example_Api');
  assert.deepEqual(ports(parent.apps),[5433,8011,8013,8768,8800]);
  assert.deepEqual(ports(parent.directApps),[5433,8011,8013,8768]);
  assert.deepEqual(ports(child.apps),[8800]);assert.deepEqual(ports(child.directApps),[8800]);
  assert.deepEqual(directPorts(roots),[5433,8011,8013,8768,8800]);
  assert.deepEqual(flattenProjects(roots).map(project=>project.id),['example-suite',apiId]);
  assert.deepEqual(projectTrail(roots,apiId).map(project=>project.id),['example-suite',apiId]);
  assert.deepEqual(projectTrail(roots,'missing'),[]);
  assert.equal(groupServices(parent).length,5);
  assert.equal(groupFolders(parent).flatMap(folder=>folder.services).length,4);
  assert.equal(groupFolders(child).flatMap(folder=>folder.services).length,1);
});

test('a child-only inventory creates a usable synthetic Example parent without inventing service endpoints',()=>{
  const roots=groupProjects(projectApps([planApi]));
  assert.equal(roots.length,1);assert.equal(roots[0].id,'example-suite');
  assert.equal(roots[0].name,'Example Suite');assert.equal(roots[0].directory,'/home/Example_Suite');
  assert.equal(roots[0].primaryPort,8011);assert.deepEqual(roots[0].directApps,[]);
  assert.deepEqual(ports(roots[0].apps),[8800]);assert.deepEqual(groupFolders(roots[0]),[]);
  assert.equal(roots[0].children[0].id,apiId);
});

test('closed parent and child services stay in their original scopes and source folders',()=>{
  const root=groupProjects(projectApps([...plan.map(app=>({...app,active:false})),{...planApi,active:false}]))[0];
  assert.deepEqual(ports(root.apps),[5433,8011,8013,8768,8800]);
  assert.ok(root.apps.every(app=>app.active===false));
  assert.equal(root.children[0].id,apiId);
  assert.equal(root.children[0].apps[0].filesPath,'/home/Example_Api');
  assert.equal(groupFolders(root).flatMap(folder=>folder.services).length,4);
});

test('Example child identity requires its folder or verified unit and never follows a reused port or foreign server',()=>{
  const reused=projectApps([endpoint(8800,{directory:'/home/unrelated-api',control:{unit:'unrelated.service'}})]);
  assert.equal(reused[0].project.parent,undefined);assert.notEqual(reused[0].project.id,apiId);
  const unit=projectApps([endpoint(8800,{directory:'/',control:{unit:'example-api.service'}})])[0];
  assert.equal(unit.project.id,apiId);assert.equal(unit.project.parent.id,'example-suite');
  const folder=projectApps([{...planApi,control:undefined}])[0];
  assert.equal(folder.project.parent.id,'example-suite');
  for(const target of [{id:'srv-222222222222222222222222',host:'192.0.2.11'},{id:'srv-111111111111111111111111',host:'192.0.2.11'},{id:'srv-333333333333333333333333',host:'192.0.2.10'}]){
    const apps=projectApps([planApi,...plan],target);
    assert.ok(apps.every(app=>app.project.parent===undefined));
    assert.ok(groupProjects(apps).every(project=>project.id!=='example-suite'));
  }
});

test('Data Platform retains worker identity as a physical child with its own two endpoints',()=>{
  const roots=groupProjects(projectApps([
    endpoint(8020,{directory:'/home/data_platform'}),endpoint(8022,{directory:'/home/data_platform'}),
    endpoint(8025,{directory:'/home/data_platform/worker'}),endpoint(8030,{directory:'/home/data_platform/worker',active:false,control:{unit:'data-worker.service'}}),
  ]));
  assert.equal(roots.length,1);assert.equal(roots[0].id,'data-platform');
  assert.deepEqual(ports(roots[0].directApps),[8020,8022]);
  const child=roots[0].children[0];assert.equal(child.id,'data-worker');
  assert.equal(child.relationship.kind,'directory');assert.deepEqual(ports(child.apps),[8025,8030]);
  assert.deepEqual(ports(roots[0].apps),[8020,8022,8025,8030]);
  assert.deepEqual(projectTrail(roots,child.id).map(project=>project.id),['data-platform','data-worker']);
});

test('physical descendants choose the nearest unique ancestor without absorbing siblings',()=>{
  const roots=groupProjects([
    member(1,info('parent','/home/product')),
    member(2,info('child','/home/product/services')),
    member(3,info('grandchild','/home/product/services/report')),
    member(4,info('sibling','/home/product-new')),
  ]);
  assert.equal(roots.length,2);
  assert.deepEqual(projectTrail(roots,'grandchild').map(project=>project.id),['parent','child','grandchild']);
  assert.deepEqual(projectTrail(roots,'sibling').map(project=>project.id),['sibling']);
  assert.deepEqual(directPorts(roots),[1,2,3,4]);
});

test('ambiguous equal roots do not guess ownership of another project',()=>{
  const input=[
    member(1,info('first','/home/shared')),
    member(2,info('second','/home/shared/')),
    member(3,info('child','/home/shared/api')),
  ];
  for(const apps of [input,[...input].reverse()]){
    const roots=groupProjects(apps);
    assert.equal(roots.length,3);
    assert.ok(roots.every(project=>project.children.length===0));
    assert.deepEqual(directPorts(roots),[1,2,3]);
  }
  const normalized=groupProjects([
    member(1,info('ancestor','/home/product')),
    member(2,info('first','/home/product/shared')),
    member(3,info('second','/home/product//shared/./')),
    member(4,info('child','/home/product/shared/api')),
  ]);
  assert.deepEqual(projectTrail(normalized,'child').map(project=>project.id),['child'],'A more distant unambiguous ancestor must not override ambiguous nearest ownership');
  assert.deepEqual(projectTrail(normalized,'first').map(project=>project.id),['ancestor','first']);
  assert.deepEqual(projectTrail(normalized,'second').map(project=>project.id),['ancestor','second']);
  assert.deepEqual(directPorts(normalized),[1,2,3,4]);
});

test('common workspace roots and invalid paths never establish inferred project ownership',()=>{
  for(const directory of ['/','/home','/root','/opt','/srv','/var','/var/www','/tmp','/C:','/C:/Users']){
    const roots=groupProjects([member(1,info('workspace',directory)),member(2,info('app',(directory==='/'?'':directory)+'/project'))]);
    assert.equal(roots.length,2,directory);
  }
  for(const directory of ['relative/project','/home/product/../other','/home/product\0/child']){
    const roots=groupProjects([member(1,info('parent','/home/product')),member(2,info('unsafe',directory))]);
    assert.equal(roots.length,2,directory);
  }
  const folders=projectApps([endpoint(100,{directory:'/home/app'}),endpoint(101,{directory:'/home/api'})]);
  assert.deepEqual(folders.map(app=>app.project.directory),['/home/app','/home/api']);
  assert.equal(groupProjects(folders).length,2);
});

test('configured parent relationships take precedence over a different physical ancestor',()=>{
  const declared=info('declared','/opt/independent');
  const child=info('child','/home/physical/child',{parent:declared,relationship:{kind:'configured',label:'Bağlı alt proje',description:'Kaynakta doğrulandı.'}});
  const roots=groupProjects([member(1,info('physical','/home/physical')),member(2,child)]);
  assert.deepEqual(projectTrail(roots,'child').map(project=>project.id),['declared','child']);
  assert.equal(flattenProjects(roots).find(project=>project.id==='physical').children.length,0);
});

test('self and multi-project parent cycles terminate without duplicating or dropping endpoints',()=>{
  const self=info('self','/home/self');self.parent=self;
  assert.deepEqual(directPorts(groupProjects([member(1,self)])),[1]);
  const a=info('a','/home/a'),b=info('b','/home/b'),child=info('leaf','/home/leaf');
  a.parent=b;b.parent=a;child.parent=a;
  const roots=groupProjects([member(2,a),member(3,b),member(4,child)]);
  assert.equal(roots.length,2);
  assert.deepEqual(directPorts(roots),[2,3,4]);
  assert.deepEqual(projectTrail(roots,'leaf').map(project=>project.id),['a','leaf']);
  assert.equal(flattenProjects(roots).length,3);
});

test('cycles introduced by configured and inferred relationships release only the cycle members',()=>{
  const a=info('a','/home/product'),b=info('b','/home/product/nested'),leaf=info('leaf','/home/product/nested/report');
  a.parent=b;
  const roots=groupProjects([member(1,leaf),member(2,a),member(3,b)]);
  assert.equal(roots.length,2);
  assert.deepEqual(projectTrail(roots,'leaf').map(project=>project.id),['b','leaf']);
  assert.deepEqual(directPorts(roots),[1,2,3]);
  const c=info('c','/opt/c');a.parent=b;b.parent=c;c.parent=a;
  const longer=groupProjects([member(1,leaf),member(2,a),member(3,b),member(4,c)]);
  assert.equal(longer.length,3);
  assert.deepEqual(projectTrail(longer,'leaf').map(project=>project.id),['b','leaf']);
  assert.deepEqual(directPorts(longer),[1,2,3,4]);
  assert.equal(flattenProjects(longer).length,4);
});

test('folder grouping shows each direct endpoint once and keeps a multi-port service together',()=>{
  const project=info('root','/home/product',{primaryPort:8011});
  const root=groupProjects([
    member(8011,project,{filesPath:'/home/product/app/api',control:{unit:'main.service'}}),
    member(9011,project,{filesPath:'/home/product/app/web',control:{unit:'main.service'}}),
    member(5433,project,{filesPath:'/home/product/postgres',control:{kind:'container',label:'db'}}),
    member(9900,project,{filesPath:null,process:'ssh'}),
    member(8800,info('child','/home/product/child'),{filesPath:'/home/product/child'}),
  ])[0];
  const folders=groupFolders(root),services=folders.flatMap(folder=>folder.services);
  assert.equal(services.length,3);
  assert.equal(folders[0].directory,'/home/product/app');
  assert.deepEqual(ports(folders[0].services[0].apps),[8011,9011]);
  assert.deepEqual(ports(services.flatMap(service=>service.apps)),[5433,8011,9011,9900]);
  assert.equal(new Set(services.flatMap(service=>service.apps.map(app=>app.port))).size,4);
  const allFolders=flattenProjects([root]).flatMap(groupFolders);
  assert.deepEqual(ports(allFolders.flatMap(folder=>folder.services.flatMap(service=>service.apps))),[5433,8011,8800,9011,9900]);
  assert.equal(folders.find(folder=>folder.directory===null).name,'Klasör belirlenemedi');
});

test('synthetic parents receive concrete metadata regardless of input ordering',()=>{
  const first=groupProjects(projectApps([planApi,...plan]));
  const last=groupProjects(projectApps([...plan,planApi]));
  const shape=roots=>flattenProjects(roots).map(project=>({id:project.id,name:project.name,directory:project.directory,ports:ports(project.apps),direct:ports(project.directApps)}));
  assert.deepEqual(shape(first),shape(last));
});
