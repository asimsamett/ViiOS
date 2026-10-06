'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Cpu,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderGit2,
  Globe2,
  HardDrive,
  ImageIcon,
  LayoutGrid,
  KeyRound,
  Layers3,
  Network,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { App } from './types';
import { flattenProjects, groupProjects, groupServices } from './project-model';
import type { Capabilities, Entry } from './file-manager';
import { useFileRead } from './file-read';
import {
  fileItem,
  launcherActions,
  matchesSearch,
  normalizeLauncherItems,
  type LaunchItem,
} from './launcher-data';

type Results = {
  entries: Entry[];
  truncated: boolean;
  visited: number;
  skipped: number;
};
type Category = 'all' | 'apps' | 'files' | 'places' | 'tools' | 'recent';
function LaunchIcon({ item }: { item: LaunchItem }) {
  if(item.view==='models')return <Cpu/>;
  if(item.view==='credentials')return <KeyRound/>;
  if(item.view==='people')return <Users/>;
  if(item.view==='servers')return <Server/>;
  if(item.view==='storage')return <HardDrive/>;
  if(item.view==='endpoints')return <Network/>;
  if (item.kind === 'tasks') return <Activity />;
  if (item.kind === 'repo') return <FolderGit2 />;
  if(item.kind==='project')return <Layers3/>;
  if(item.kind==='applications')return <LayoutGrid/>;
  if (item.kind === 'app' || item.kind === 'link') return <Globe2 />;
  if (item.kind === 'trash') return <Trash2 />;
  if (item.kind === 'folder')
    return item.path === '/' ? <HardDrive /> : <Folder />;
  if (item.kind === 'file')
    return /\.(png|jpe?g|gif|webp)$/i.test(item.label) ? (
      <ImageIcon />
    ) : /\.(js|ts|tsx|py|json|css|sh|html)$/i.test(item.label) ? (
      <FileCode2 />
    ) : (
      <File />
    );
  return item.view === 'ports' ? (
    <Network />
  ) : item.view === 'reports' ? (
    <FileCode2 />
  ) : item.view === 'help' ? (
    <BookOpen />
  ) : item.view === 'apps' ? (
    <LayoutGrid />
  ) : (
    <Settings2 />
  );
}
export default function DesktopSearch({
  open,
  onClose,
  host,
  cap,
  apps,
  pins,
  recent,
  onPin,
  onClearRecent,
  onActivate,
  navigationLocked,
  generation,
  repoAvailable,
}: {
  open: boolean;
  onClose: () => void;
  host: string;
  cap: Capabilities;
  apps: App[];
  pins: LaunchItem[] | null;
  recent: LaunchItem[];
  onPin: (item: LaunchItem, defaults: LaunchItem[]) => void;
  onClearRecent: () => void;
  onActivate: (item: LaunchItem) => void;
  navigationLocked: boolean;
  generation: number;
  repoAvailable: boolean;
}) {
  const read = useFileRead(),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState<Category>('all');
  const [scope, setScope] = useState('/'),
    [hidden, setHidden] = useState(false),
    [reload, setReload] = useState(0);
  const [response, setResponse] = useState<{
    key: string;
    result?: Results;
    error?: string;
  } | null>(null);
  const term = query.trim(),
    searchKey = `${term}|${scope}|${hidden}|${generation}|${reload}`;
  const searchFiles =
    open && cap.available && term.length >= 2 && ['all', 'files'].includes(category);
  const pending = searchFiles && response?.key !== searchKey;
  const results = response?.key === searchKey ? response.result : undefined;
  const error = response?.key === searchKey ? response.error : undefined;
  useEffect(() => {
    if (!searchFiles) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void read<Results>(
        `/files/search?${new URLSearchParams({ query: term, path: scope, hidden: String(hidden) })}`,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted)
            setResponse({ key: searchKey, result });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setResponse({ key: searchKey, error: (e as Error).message });
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [read, searchFiles, searchKey, term, scope, hidden]);
  const roots=groupProjects(apps),projects=flattenProjects(roots);
  const allAppItems: LaunchItem[]=projects.map(project=>({id:`project:${project.id}`,kind:'project',projectId:project.id,label:project.name,detail:`${groupServices(project).length} servis · ${project.apps.map(app=>':'+app.port).join(', ')}`}));
  const appItemById=new Map(allAppItems.map(item=>[item.projectId,item]));
  const appItems=roots.map(project=>appItemById.get(project.id)!);
  const places: LaunchItem[] = cap.available ? [
    fileItem('/', 'folder'),
    ...cap.roots.map((path) => fileItem(path, 'folder')),
    {
      id: 'trash',
      kind: 'trash',
      label: 'Çöp kutusu',
      detail: 'Kaldırılan öğeleri geri yükleyin',
    },
  ] : [];
  const availableActions = launcherActions.filter(
    (item) => (item.kind !== 'repo' || repoAvailable) && !['action:apps','action:managed'].includes(item.id),
  );
  const defaults = [
    launcherActions.find((item) => item.id === 'applications')!,
    launcherActions.find((item) => item.view === 'models')!,
    launcherActions.find((item) => item.view === 'credentials')!,
    launcherActions.find((item) => item.id === 'tasks')!,
    ...(repoAvailable
      ? [launcherActions.find((item) => item.id === 'repo')!]
      : []),
    ...(cap.available?[fileItem(cap.defaultPath || '/', 'folder'),places.at(-1)!]:[]),
    ...appItems
      .filter(
        (item) => projects.find(project=>project.id===item.projectId)?.apps.some(app=>app.active!==false),
      )
      .slice(0, 4),
  ];
  const current=(item:LaunchItem)=>{
    if(!cap.available && ['folder','file','trash'].includes(item.kind))return undefined;
    if(item.kind==='repo' && !repoAvailable)return undefined;
    if(item.kind==='project')return appItemById.get(item.projectId);
    if(item.kind==='app'){
      const app=apps.find(app=>app.port===item.port);
      return app?appItemById.get(app.project?.id || `port:${app.port}`):undefined;
    }
    if(item.kind==='action' && (item.view==='managed' || item.view==='apps'))return launcherActions.find(action=>action.id==='applications');
    return item;
  };
  const pinned = normalizeLauncherItems(pins || defaults, apps)
    .map(current)
    .filter((x): x is LaunchItem => !!x);
  const recentItems = normalizeLauncherItems(recent, apps)
    .map((item) => {
      const value = current(item);
      return value ? { ...value, openedAt: item.openedAt } : null;
    })
    .filter((x): x is LaunchItem & { openedAt: number | undefined } => !!x);
  const fileItems = (results?.entries || []).map((entry) =>
    fileItem(
      entry.path,
      entry.kind === 'directory' ? 'folder' : 'file',
      entry.name,
    ),
  );
  const categories: {
    id: Category;
    label: string;
    icon: typeof Search;
    items: LaunchItem[];
  }[] = [
    { id: 'apps', label: 'Uygulamalar', icon: Globe2, items: appItems },
    { id: 'places', label: 'Konumlar', icon: FolderOpen, items: places },
    {
      id: 'tools',
      label: 'Yönetim araçları',
      icon: Settings2,
      items: availableActions,
    },
    {
      id: 'files',
      label: 'Dosyalar',
      icon: File,
      items: recentItems.filter((i) => i.kind === 'file'),
    },
  ];
  const filteredApps=appItems.filter(item=>{
    const project=projects.find(project=>project.id===item.projectId);
    const descendants=project?flattenProjects([project]):[];
    return matchesSearch(`${item.label} ${item.detail} ${descendants.map(child=>`${child.name} ${child.directory || ''}`).join(' ')} ${project?.apps.map(app=>`${app.name} ${app.serviceName || ''} ${app.control?.label || ''} ${app.directory} ${app.filesPath || ''} ${app.annotation?.tags.join(' ') || ''}`).join(' ') || ''}`,term);
  });
  const groups =
    category === 'recent'
      ? [
          {
            label: 'Son açılanlar',
            items: recentItems.filter((i) =>
              matchesSearch(`${i.label} ${i.path || ''}`, term),
            ),
          },
        ]
      : [
          ...(['all', 'apps'].includes(category)
            ? [{ label: 'Uygulamalar', items: filteredApps }]
            : []),
          ...(['all', 'tools'].includes(category)
            ? [
                {
                  label: 'Yönetim araçları',
                  items: availableActions.filter((i) =>
                    matchesSearch(`${i.label} ${i.detail}`, term),
                  ),
                },
              ]
            : []),
          ...(['all', 'places'].includes(category)
            ? [
                {
                  label: 'Konumlar',
                  items: places.filter((i) =>
                    matchesSearch(`${i.label} ${i.path || ''}`, term),
                  ),
                },
              ]
            : []),
          ...(['all', 'files'].includes(category) && term.length >= 2
            ? [{ label: 'Dosya ve klasör sonuçları', items: fileItems }]
            : []),
        ];
  const landing = !term && category === 'all';
  function row(item: LaunchItem, tile = false) {
    const isPinned = pinned.some((p) => p.id === item.id),
      locked = item.kind === 'action' && navigationLocked;
    const content = <>
      <span className={`ui-icon launcher-icon ${item.kind}`}><LaunchIcon item={item} /></span>
      <span>
        <strong>{item.label}</strong>
        {!tile && <small>
          {item.openedAt ? new Date(item.openedAt).toLocaleString('tr-TR', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          }) + ' · ' : ''}
          {item.detail || item.path}
        </small>}
      </span>
      {!tile && <ArrowUpRight className="launcher-open-arrow" size={16} />}
    </>;
    return (
      <div
        key={item.id}
        className={`launcher-item ${tile ? 'tile' : 'row'} ${item.kind}`}
      >
        {item.kind === 'link' ? <a className="launcher-item-open" href={item.url} target="_blank" rel="noopener noreferrer" title={item.url} onClick={() => onActivate(item)}>{content}</a> : <button
          className="launcher-item-open"
          disabled={locked}
          title={
            locked
              ? 'Önce dosyanızı kaydedin veya dosya penceresini kapatın.'
              : item.path || item.detail || item.label
          }
          onClick={() => onActivate(item)}
        >
          {content}
        </button>}
        <button
          className={`launcher-pin ${isPinned ? 'pinned' : ''}`}
          title={isPinned ? 'Sabitlemeyi kaldır' : 'Başlangıca sabitle'}
          aria-label={`${item.label} ${isPinned ? 'sabitlemesini kaldır' : 'başlangıca sabitle'}`}
          aria-pressed={isPinned}
          onClick={() => onPin(item, defaults)}
        >
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </div>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="desktop-launcher"
        showCloseButton={false}
        initialFocus={input}
        finalFocus={false}
      >
        <DialogTitle className="sr-only">Uygulama ve dosya arama</DialogTitle>
        <DialogDescription className="sr-only">
          {host} uygulamaları, proje dosyaları, sabitlenenler ve son açılanlar.
        </DialogDescription>
        <header className="launcher-search-header">
          <div className="launcher-search-field">
            <Search size={21} />
            <Input
              ref={input}
              aria-label="Uygulama, port, dosya veya klasör ara"
              placeholder="Uygulama, port, dosya veya klasör ara…"
              value={query}
              maxLength={120}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                aria-label="Aramayı temizle"
                onClick={() => {
                  setQuery('');
                  input.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
            <kbd>Ctrl K</kbd>
          </div>
        </header>
        <div className="launcher-body">
          {!landing && (
            <nav className="launcher-filters" aria-label="Arama kategorileri">
              <button
                className={category === 'all' ? 'active' : ''}
                onClick={() => setCategory('all')}
              >
                Tümü
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={category === c.id ? 'active' : ''}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                </button>
              ))}
              {category === 'recent' && (
                <button className="active">Son açılanlar</button>
              )}
            </nav>
          )}
          {landing ? (
            <>
              <section className="launcher-section">
                <div className="launcher-section-title">
                  <h3>Sabitlenenler</h3>
                  <span>{pinned.length} öğe</span>
                </div>
                <div className="launcher-pinned-grid">
                  {pinned.map((item) => row(item, true))}
                </div>
                {!pinned.length && (
                  <p className="launcher-empty">
                    Öğenin iğne düğmesiyle buraya ekleyebilirsiniz.
                  </p>
                )}
              </section>
              <section className="launcher-section">
                <div className="launcher-section-title">
                  <h3>Son açılanlar</h3>
                  <button onClick={() => setCategory('recent')}>
                    Tümünü göster <ChevronRight size={15} />
                  </button>
                </div>
                <div className="launcher-recent-grid">
                  {recentItems.slice(0, 6).map((item) => row(item))}
                </div>
                {!recentItems.length && (
                  <p className="launcher-empty">
                    Açtığınız dosya, klasör ve uygulamalar burada görünür.
                  </p>
                )}
              </section>
              <section className="launcher-section">
                <div className="launcher-section-title">
                  <h3>Tümü</h3>
                  <span>Kategori görünümü</span>
                </div>
                <div className="launcher-category-grid">
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setCategory(c.id);
                        if (c.id === 'files') input.current?.focus();
                      }}
                    >
                      <span className="launcher-category-art">
                        <c.icon />
                        <span>
                          {c.items.slice(0, 3).map((i) => (
                            <LaunchIcon key={i.id} item={i} />
                          ))}
                        </span>
                      </span>
                      <strong>{c.label}</strong>
                      <small>
                        {c.id === 'files'
                          ? 'Proje alanlarında ara'
                          : `${c.items.length} öğe`}
                      </small>
                    </button>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="launcher-results-heading">
                <button
                  onClick={() => {
                    setCategory('all');
                    setQuery('');
                  }}
                >
                  <ArrowLeft size={16} />
                  Başlangıç
                </button>
                <span>
                  {term
                    ? `“${term}” için sonuçlar`
                    : category === 'recent'
                      ? 'Bu tarayıcıdaki geçmiş'
                      : 'Tüm öğeler'}
                </span>
                {category === 'recent' && (
                  <button onClick={onClearRecent}>Geçmişi temizle</button>
                )}
              </div>
              {['all', 'files'].includes(category) && (
                <div className="launcher-search-scope">
                  <label>
                    Dosya konumu
                    <select
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                    >
                      <option value="/">Tüm proje alanları</option>
                      {cap.roots.map((root) => (
                        <option key={root} value={root}>
                          {root}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="launcher-hidden">
                    <input
                      type="checkbox"
                      checked={hidden}
                      onChange={(e) => setHidden(e.target.checked)}
                    />
                    Gizli öğeler
                  </label>
                </div>
              )}
              {groups.map(
                (group) =>
                  !!group.items.length && (
                    <section
                      className="launcher-result-group"
                      key={group.label}
                    >
                      <h3>
                        {group.label}
                        <span>{group.items.length}</span>
                      </h3>
                      <div>{group.items.map((item) => row(item))}</div>
                    </section>
                  ),
              )}
              {pending && (
                <output className="launcher-feedback">
                  <RefreshCw size={17} className="spin" />
                  Proje dosyaları aranıyor…
                </output>
              )}
              {error && (
                <div className="launcher-feedback error" role="alert">
                  <CircleHelp size={17} />
                  <span>{error}</span>
                  <Button
                    variant="outline"
                    onClick={() => setReload((n) => n + 1)}
                  >
                    Tekrar dene
                  </Button>
                </div>
              )}
              {['all', 'files'].includes(category) && term.length < 2 && (
                <p className="launcher-empty">
                  Dosya adlarında aramak için en az 2 karakter yazın.
                </p>
              )}
              {!pending &&
                !error &&
                !groups.some((g) => g.items.length) &&
                !(category === 'files' && term.length < 2) && (
                  <div className="launcher-no-results">
                    <Search size={32} />
                    <h3>Sonuç bulunamadı</h3>
                    <p>Farklı bir ad, port veya proje konumu deneyin.</p>
                  </div>
                )}
              {results && (
                <p className="launcher-search-note">
                  {results.truncated
                    ? 'Arama sınırına ulaşıldı; sonuçlar kısmi. Daha belirgin bir ad yazın veya tek proje alanı seçin.'
                    : `${results.visited.toLocaleString('tr-TR')} öğe incelendi.`}{' '}
                  Bağımlılık ve derleme klasörlerinin içi aranmaz; korumalı
                  alanlar kapsam dışıdır.
                  {results.skipped > 0 ? ' Bazı klasörler okunamadı.' : ''}
                </p>
              )}
            </>
          )}
        </div>
        <footer className="launcher-footer">
          <span className="launcher-user">
            <ShieldCheck size={21} />
            <span>
              <strong>Yönetici</strong>
              <small>{host}</small>
            </span>
          </span>
          <span className="launcher-device-note">
            Sabitlenenler ve geçmiş bu tarayıcıda saklanır.
          </span>
          <button
            title="Aramayı kapat"
            aria-label="Aramayı kapat"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
