'use client';
import { useState } from 'react';
import AppCredentials from './app-credentials';
import ProjectTeam, { ProjectTeamSummary, ServiceTeam } from './project-team';
import ModelConnections, { ModelSummary, modelSearchText } from './model-connections';
import { ArrowLeft, ArrowUpRight, Box, ChevronRight, Code2, Database, FolderGit2, FolderOpen, GitBranch, Globe2, History, KeyRound, Layers3, Search, Server, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ControlActions, { canManage } from './control-actions';
import { groupProjects, groupServices, groupFolders, flattenProjects, projectTrail, endpointIssue, type ProjectGroup, type ProjectService } from './project-model';
import { useTarget } from './target-context';
import type { App, ControlAction, Inventory } from './types';

export type ProjectAppsProps = { inventory: Inventory | null; busy: boolean; onAction: (app: App, action: ControlAction) => void; onSelect: (app: App) => void; onHistory: (port: number) => void; onFiles: (path: string) => void; onRepo: (path: string) => void; repoAvailable?: boolean; managedOnly?: boolean; initialProjectId?: string; visible?: boolean };
type StructureProps = Pick<ProjectAppsProps, 'inventory' | 'busy' | 'onAction' | 'onSelect' | 'onHistory' | 'onFiles' | 'onRepo' | 'repoAvailable'> & { project: ProjectGroup; ancestors: ProjectGroup[]; onProject: (id: string) => void };

function ProjectIcon({ project }: { project: ProjectGroup }) {
  return <span className="ui-icon project-icon" aria-hidden="true">{project.system ? <Server size={30}/> : <Layers3 size={30}/>}</span>;
}
const endpointAddress = (app: App, host: string) => {
  const address = app.internal ? (app.addresses.find(address => address.startsWith('127.') || address === '::1') || '127.0.0.1') : host;
  const hostname = address.includes(':') ? `[${address}]` : address;
  return `${app.protocol.includes('http') ? app.protocol + '://' : ''}${hostname}:${app.port}${app.protocol.includes('http') ? app.path : ''}`;
};
const endpointStatus = (app: App) => app.active === false ? 'Kapalı' : app.networkState === 'unknown' ? 'Erişim belirsiz' : endpointIssue(app) ? 'Yanıt kontrol edilmeli' : 'Çalışıyor';

function ServiceCard({ project, ancestors, service, inventory, busy, onAction, onSelect, onHistory, onFiles }: StructureProps & { service: ProjectService }) {
  const { url, id: serverId } = useTarget();
  const app = service.apps.find(canManage) || service.apps[0];
  const isDatabase = /postgres|mysql|redis|veritaban/i.test(`${service.name} ${app.process}`);
  const Icon = isDatabase ? Database : app.kind === 'web' ? Globe2 : app.control?.kind === 'container' ? Box : Code2;
  const folders = [...new Set(service.apps.map(app => app.filesPath).filter((path): path is string => !!path))];
  return <article className="project-service">
    <div className="project-service-heading"><span className="ui-icon project-service-icon"><Icon size={21}/></span><div><h3>{service.name.startsWith(project.name + ' · ') ? service.name.slice(project.name.length + 3) : service.name}</h3><p>{app.control?.label || app.process || 'Servis'}{app.control?.kind === 'container' ? ' · Container' : ''}</p></div>{service.apps.some(endpointIssue) && <span className="project-status issue">Kontrol gerekli</span>}</div>
    <ServiceTeam serverId={serverId} projectId={project.id} projectPath={project.directory} service={service} relatedProjects={ancestors}/>
    <ModelSummary apps={service.apps}/>
    <div className="project-endpoints">{service.apps.map(endpoint => <div className="project-endpoint" key={endpoint.port}>
      <button className="project-port" onClick={() => onSelect(endpoint)} aria-label={`:${endpoint.port} servis ayrıntıları`}><code>:{endpoint.port}</code><span>{(endpoint.transports || [endpoint.protocol]).join(' / ').toUpperCase()}</span><ArrowUpRight size={13}/></button>
      <span className={`project-status ${endpoint.active === false ? 'stopped' : endpointIssue(endpoint) ? 'issue' : 'running'}`}><i/>{endpointStatus(endpoint)}</span>
      <code className="project-endpoint-address">{endpointAddress(endpoint, inventory?.host || '')}</code>
      <span className="project-access">{endpoint.internal ? 'Sunucu içi' : 'Ağ erişimi'}</span>
      <div className="project-endpoint-actions">{endpoint.openUrl && <a href={url(`/apps/${endpoint.port}/open`)} target="_blank" rel="noopener noreferrer" aria-label={`:${endpoint.port} adresini aç`}><ArrowUpRight size={15}/>Aç</a>}<Button variant="ghost" onClick={() => onHistory(endpoint.port)} aria-label={`:${endpoint.port} günlüğü`}><History size={14}/>Günlük</Button></div>
    </div>)}</div>
    <div className="project-service-footer"><div className="project-source-links">{folders.length ? folders.map(folder => <button key={folder} onClick={() => onFiles(folder)} aria-label={`${service.name} dosyalarını aç`}><FolderOpen size={16}/><span><strong>Dosyalara git</strong><code>{folder}</code></span><ArrowUpRight size={13}/></button>) : <span className="project-no-files"><ShieldCheck size={15}/>Bu servis için proje klasörü belirlenemedi.</span>}{service.apps.some(app => app.entry) && <small>Kaynak: {[...new Set(service.apps.map(app => app.entry).filter(Boolean))].join(', ')}</small>}</div><ControlActions app={app} inventory={inventory} busy={busy} onAction={onAction}/></div>
  </article>;
}

function ProjectStructure(props: StructureProps) {
  const { project, ancestors, onFiles, onRepo, onProject, repoAvailable } = props;
  const { id: serverId } = useTarget();
  const folders = groupFolders(project);
  return <div className="project-structure">
    {folders.map(folder => <section className="project-folder" key={folder.id} aria-label={`${project.name} · ${folder.name} klasörü`}>
      <header className="project-folder-heading"><span className="ui-icon project-folder-icon"><FolderOpen size={19}/></span><div><span className="project-node-kind">KLASÖR</span><h4>{folder.name}</h4>{folder.directory && <code>{folder.directory}</code>}<p>{folder.services.length} servis · {folder.services.reduce((count, service) => count + service.apps.length, 0)} port</p></div>{folder.directory && <div className="project-node-actions"><Button variant="outline" onClick={() => onFiles(folder.directory!)} aria-label={`${folder.directory} klasörünü aç`}><FolderOpen size={14}/>Dosyalar</Button><Button variant="outline" disabled={!repoAvailable} title={repoAvailable ? undefined : 'Bu sunucuda Git entegrasyonu kullanılamıyor'} onClick={() => onRepo(folder.directory!)} aria-label={`${folder.directory} klasörünü Repo Merkezi'nde aç`}><FolderGit2 size={14}/>Repo Merkezi</Button></div>}</header>
      <div className="project-services">{folder.services.map(service => <ServiceCard {...props} service={service} key={service.id}/>)}</div>
    </section>)}
    {project.children.map(child => <section className="project-child" key={child.id} aria-label={`${child.name} alt projesi`}>
      <header className="project-child-heading"><span className="ui-icon project-child-icon"><Layers3 size={22}/></span><div className="project-child-copy"><span className="project-node-kind">ALT PROJE</span><h3>{child.name}</h3><p>{groupServices(child).length} servis · {child.apps.length} port</p>{child.directory && <code>{child.directory}</code>}</div><div className="project-node-actions">{child.directory && <><Button variant="outline" onClick={() => onFiles(child.directory!)} aria-label={`${child.name} alt proje dosyalarını aç`}><FolderOpen size={14}/>Dosyalar</Button><Button variant="outline" disabled={!repoAvailable} title={repoAvailable ? undefined : 'Bu sunucuda Git entegrasyonu kullanılamıyor'} onClick={() => onRepo(child.directory!)} aria-label={`${child.name} alt projesini Repo Merkezi'nde aç`}><FolderGit2 size={14}/>Repo Merkezi</Button></>}<Button variant="outline" onClick={() => onProject(child.id)} aria-label={`${child.name} alt projesini aç`}>Alt projeyi aç<ArrowUpRight size={14}/></Button></div></header>
      {child.relationship && <div className="project-relationship"><GitBranch size={15}/><div><strong>{child.relationship.label}</strong><p>{child.relationship.description}</p></div></div>}
      <div className="project-child-summary"><ProjectTeamSummary serverId={serverId} projectId={child.id} projectPath={child.directory} relatedProjects={flattenProjects(child.children)}/><ModelSummary apps={child.apps}/></div>
      <ProjectStructure {...props} project={child} ancestors={[...ancestors, project]}/>
    </section>)}
  </div>;
}

export default function ProjectApps({ inventory, busy, onAction, onSelect, onHistory, onFiles, onRepo, repoAvailable = false, managedOnly = false, initialProjectId, visible: screenVisible = true }: ProjectAppsProps) {
  const { url, id: serverId } = useTarget();
  const [selected, setSelected] = useState<string | null>(initialProjectId || null), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const projects = groupProjects(inventory?.apps || []).filter(project => !managedOnly || project.apps.some(canManage));
  const project = flattenProjects(projects).find(project => project.id === selected);
  const normalized = query.toLocaleLowerCase('tr-TR');
  const visible = projects.filter(project => (filter === 'all' || filter === 'running' && project.apps.some(app => app.active !== false) || filter === 'stopped' && project.apps.every(app => app.active === false) || filter === 'issues' && project.apps.some(endpointIssue)) && `${flattenProjects([project]).map(node => `${node.name} ${node.directory || ''}`).join(' ')} ${project.apps.map(app => `${app.port} ${modelSearchText(app)} ${app.name} ${app.serviceName || ''} ${app.control?.label || ''} ${app.directory} ${app.annotation?.tags.join(' ') || ''}`).join(' ')}`.toLocaleLowerCase('tr-TR').includes(normalized));
  if (project) {
    const services = groupServices(project), running = project.apps.filter(app => app.active !== false).length;
    const descendants = flattenProjects(project.children), trail = projectTrail(projects, project.id);
    const main = project.apps.find(app => app.port === project.primaryPort) || project.directApps.find(app => app.kind === 'web' && app.openUrl) || project.apps.find(app => app.openUrl);
    return <section className="project-apps project-detail" aria-label={`${project.name} uygulaması`}>
      <div className="project-navigation"><Button variant="ghost" className="project-back" onClick={() => setSelected(null)}><ArrowLeft size={17}/>Tüm uygulamalar</Button>{trail.length > 1 && <nav className="project-breadcrumb" aria-label="Proje hiyerarşisi"><ol>{trail.map((node, index) => <li key={node.id}>{index > 0 && <ChevronRight size={13}/>} {node.id === project.id ? <span aria-current="page">{node.name}</span> : <button onClick={() => setSelected(node.id)}>{node.name}</button>}</li>)}</ol></nav>}</div>
      <header className="project-detail-header"><ProjectIcon project={project}/><div><span className="project-eyebrow">UYGULAMA VE SERVİSLER</span><h2>{project.name}</h2><p>{descendants.length > 0 && `${descendants.length} alt proje · `}{services.length} servis · {project.apps.length} port · {running} açık</p></div><div className="project-main-actions">{project.directory && <Button variant="outline" onClick={() => onFiles(project.directory!)}><FolderOpen size={16}/>Proje dosyaları</Button>}{project.directory && <Button variant="outline" disabled={!repoAvailable} title={repoAvailable ? undefined : 'Bu sunucuda Git entegrasyonu kullanılamıyor'} onClick={() => onRepo(project.directory!)}><FolderGit2 size={16}/>Repo Merkezi</Button>}{main?.openUrl && <a className="primary-link" href={url(`/apps/${main.port}/open`)} target="_blank" rel="noopener noreferrer">Uygulamayı aç <ArrowUpRight size={16}/></a>}</div></header>
      {project.directory && <div className="project-location"><FolderOpen size={15}/><code>{project.directory}</code></div>}
      {project.relationship && <div className="project-relationship project-detail-relationship"><GitBranch size={15}/><div><strong>{project.relationship.label}</strong><p>{project.relationship.description}</p></div></div>}
      <ProjectTeam key={project.id} serverId={serverId} project={project} relatedProjects={descendants} services={services} visible={screenVisible}/>
      {!project.system && <ModelConnections apps={project.apps}/>}
      {inventory?.error && <p className="notice error-notice">Son başarılı tarama gösteriliyor. {inventory.error}</p>}
      {inventory?.controlError && <p className="notice error-notice">{inventory.controlError}</p>}
      <div className="project-hierarchy"><header className="project-hierarchy-heading"><GitBranch size={19}/><div><h3>Proje yapısı</h3><p>Klasörler, servisler ve alt projeler</p></div></header><ProjectStructure project={project} ancestors={trail.slice(0, -1)} inventory={inventory} busy={busy} onAction={onAction} onSelect={onSelect} onHistory={onHistory} onFiles={onFiles} onRepo={onRepo} repoAvailable={repoAvailable} onProject={setSelected}/></div>
    </section>;
  }
  return <section className="project-apps" aria-label="Proje uygulamaları">
    <header className="project-catalog-heading"><span className="ui-icon project-catalog-mark"><Layers3 size={25}/></span><div><h2>Uygulamalar <span>{projects.length + (managedOnly ? 0 : 1)}</span></h2><p>Bir uygulama seçin; alt projeleri, bağlı servisleri, portları ve dosyaları birlikte görüntüleyin.</p></div></header>
    <div className="project-catalog-toolbar"><div className="filter-group">{[['all', 'Tümü'], ['running', 'Çalışan'], ['stopped', 'Kapalı'], ['issues', 'Kontrol gerekli']].map(([id, label]) => <Button key={id} variant="ghost" className={`filter ${filter === id ? 'active' : ''}`} aria-pressed={filter === id} onClick={() => { if (filter === 'credentials') setQuery(''); setFilter(id); }}>{label}</Button>)}<Button variant="ghost" className={`filter credential-tab ${filter === 'credentials' ? 'active' : ''}`} aria-pressed={filter === 'credentials'} onClick={() => { if (filter !== 'credentials') setQuery(''); setFilter('credentials'); }}><KeyRound size={15}/>Uygulamalar ve Şifreler</Button></div><div className="search-field"><Search size={16}/><Input aria-label={filter === 'credentials' ? 'Uygulama erişim bilgilerini ara' : 'Proje, servis veya port ara'} placeholder={filter === 'credentials' ? 'Uygulama, adres veya kullanıcı adı ara…' : 'Uygulama, model, adres veya port ara…'} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="Proje aramasını temizle" onClick={() => setQuery('')}><X size={14}/></button>}</div></div>
    {filter === 'credentials' ? (screenVisible && <AppCredentials key={serverId} query={query}/>) : <>
    {inventory?.controlError && <p className="notice error-notice">{inventory.controlError}</p>}
    <div className="project-grid">{visible.map(project => {
      const running = project.apps.filter(app => app.active !== false).length, issues = project.apps.some(endpointIssue), descendants = flattenProjects(project.children);
      return <button className="project-tile" key={project.id} onClick={() => setSelected(project.id)} aria-label={`${project.name} uygulamasını görüntüle`}><ProjectIcon project={project}/><strong>{project.name}</strong><span>{groupServices(project).length} servis · {project.apps.length} port</span>{descendants.length > 0 && <span className="project-child-count"><GitBranch size={12}/>{descendants.length} alt proje</span>}<small className={`project-status ${issues ? 'issue' : running ? 'running' : 'stopped'}`}><i/>{issues ? 'Kontrol gerekli' : running === project.apps.length ? 'Çalışıyor' : running ? `${running} açık · ${project.apps.length - running} kapalı` : 'Kapalı'}</small><ModelSummary apps={project.apps}/><ProjectTeamSummary serverId={serverId} projectId={project.id} projectPath={project.directory} relatedProjects={descendants}/></button>;
    })}</div>
    {!visible.length && <div className="log-empty"><Layers3 size={30}/><strong>{inventory ? 'Bu filtrede uygulama bulunamadı.' : 'Uygulamalar yükleniyor…'}</strong>{(query || filter !== 'all') && <Button variant="outline" onClick={() => { setQuery(''); setFilter('all'); }}>Filtreleri temizle</Button>}</div>}
    <p className="project-catalog-footer">{visible.length} uygulama · {visible.reduce((count, project) => count + project.apps.length, 0)} port</p>
    </>}
  </section>;
}
