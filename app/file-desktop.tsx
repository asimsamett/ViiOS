'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import {
  Activity,
  Bell,
  Cpu,
  History,
  KeyRound,
  LogOut,
  Server,
  Users,
  CircleHelp,
  Copy,
  FileText,
  Folder,
  FolderGit2,
  Grid2X2,
  HardDrive,
  Search,
  Minus,
  Monitor,
  Network,
  PanelsTopLeft,
  Plus,
  Settings2,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Appearance, { useWallpaper } from './appearance';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import FileExplorer, {
  type Capabilities,
  type Clipboard,
  type Entry,
} from './file-manager';
import { FileDocument, FileTrash } from './file-document';
import { useTarget } from './target-context';
import { useFileRead } from './file-read';
import DesktopSearch from './desktop-search';
import TaskManager from './task-manager';
import VersionPanel, { type VersionCapabilities } from './version-panel';
import RepoCenter from './repo-center';
import DesktopDock from './desktop-dock';
import DesktopCustomizer from './desktop-customizer';
import { useDesktopLayout } from './desktop-layout';
import ViiBrandIcon from './vii-brand-icon';
import TaskbarPreview, { type PreviewWindow } from './taskbar-preview';
import {
  fileItem,
  launcherActions,
  launcherEntry,
  useLauncherPreferences,
  type LaunchItem,
  type DesktopView,
} from './launcher-data';
import type { App, Inventory, ControlAction } from './types';
import ProjectApps from './project-apps';
import { flattenProjects, groupProjects } from './project-model';
import {
  activeWindow,
  clampWindow,
  focusWindow,
  initialWindowState,
  type DesktopBounds,
  type WindowRect,
} from './desktop-state';

type DesktopWindow = {
  id: string;
  order: number;
  kind: 'folder' | 'file' | 'trash' | 'tasks' | 'repo' | 'applications' | 'tool';
  path: string;
  initialPath: string;
  launchRevision?: number;
  entry?: Entry;
  minimized: boolean;
  maximized: boolean;
  dirty: boolean;
  rect: WindowRect;
};
const nameOf = (w: DesktopWindow) =>
  w.kind === 'tool' ? launcherActions.find(item=>item.view===w.path)?.label || 'Yönetim aracı' : w.kind === 'applications' ? 'Uygulamalar' : w.kind === 'repo'
    ? 'Repo Merkezi'
    : w.kind === 'tasks'
      ? 'Görev Yöneticisi'
      : w.kind === 'trash'
        ? 'Çöp kutusu'
        : w.path === '/'
          ? 'Bu sunucu'
          : w.path.split('/').filter(Boolean).at(-1) || 'Dosya Gezgini';
function ToolIcon({view,size=18}:{view:string;size?:number}) {
  const Icon=view==='models'?Cpu:view==='credentials'?KeyRound:view==='people'?Users:view==='servers'?Server:view==='storage'?HardDrive:view==='help'?CircleHelp:view==='reports'?FileText:Network;
  return <Icon size={size}/>;
}
function WindowIcon({
  kind,
  path,
  size = 18,
}: {
  kind: DesktopWindow['kind'];
  path?: string;
  size?: number;
}) {
  return kind === 'tool' ? <ToolIcon view={path || ''} size={size}/> : kind === 'applications' ? <Grid2X2 size={size}/> : kind === 'repo' ? (
    <FolderGit2 size={size} />
  ) : kind === 'tasks' ? (
    <Activity size={size} />
  ) : kind === 'folder' ? (
    <Folder size={size} />
  ) : kind === 'trash' ? (
    <Trash2 size={size} />
  ) : (
    <FileText size={size} />
  );
}

function ShortcutIcon({ item }: { item: LaunchItem }) {
  if (item.kind === 'link') return <Network size={18}/>;
  if (item.kind === 'action') return <ToolIcon view={item.view || ''}/>;
  if (item.kind === 'project' || item.kind === 'app' || item.kind === 'applications') return <Grid2X2 size={18}/>;
  if (item.kind === 'folder' && item.path === '/') return <Monitor size={18}/>;
  return <WindowIcon kind={item.kind}/>;
}

export default function FileDesktop({
  host,
  apps,
  inventory,
  busy: controlBusy,
  onAction,
  onHistory,
  fileRequest,
  repoRequest,
  navigationRequest,
  renderPanel,
  onLogout,
  onNotifications,
  notificationCount = 0,
  onScan,
  scanning = false,
  connectionError = '',
  onApp,
  onMessage,
  onBusy,
}: {
  host: string;
  apps: App[];
  inventory: Inventory|null;
  busy: boolean;
  onAction: (app:App,action:ControlAction)=>void;
  onHistory: (port:number|null)=>void;
  fileRequest: {id:number;path:string}|null;
  repoRequest: {id:number;path:string}|null;
  navigationRequest: {id:number;view:DesktopView}|null;
  renderPanel: (view: DesktopView, visible:boolean) => ReactNode;
  onLogout: () => void;
  onNotifications: () => void;
  notificationCount?: number;
  onScan: () => void;
  scanning?: boolean;
  connectionError?: string;
  onApp: (app: App) => void;
  onMessage: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const wallpaper = useWallpaper('desktop');
  const { api, id: serverId } = useTarget(),
    read = useFileRead();
  const preferences = useLauncherPreferences(serverId, apps);
  const desktopLayout = useDesktopLayout();
  const [customizing, setCustomizing] = useState(false);
  const remember=preferences.remember;
  const initialFileRequest=useRef(fileRequest),handledFileRequest=useRef<number|null>(null);
  const initialRepoRequest=useRef(repoRequest),handledRepoRequest=useRef<number|null>(null);
  const handledNavigation=useRef<number|null>(null);
  const [requestedRepoPath,setRequestedRepoPath]=useState(repoRequest);
  const repoSequence=useRef(repoRequest?.id || 0);
  const [cap, setCap] = useState<Capabilities>({available:false,roots:[],reason:'Dosya erişimi hazırlanıyor.'}),
    [error, setError] = useState('');
  const [windows, setWindows] = useState<DesktopWindow[]>([]),
    [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [copiedPath, setCopiedPath] = useState<{
    serverId: string;
    path: string;
  } | null>(null);
  const [generation, setGeneration] = useState(0),
    [writing, setWriting] = useState(false);
  const [preparing, setPreparing] = useState<Record<string, boolean>>({});
  const [versionCapability, setVersionCapability] =
    useState<VersionCapabilities | null>(null);
  const [versions, setVersions] = useState<{ path?: string } | null>(null);
  const [requestedRepoId, setRequestedRepoId] = useState<string | null>(null);
  const [versionBusy, setVersionBusy] = useState(false);
  const busy = writing || versionBusy || Object.values(preparing).some(Boolean);
  const [discard, setDiscard] = useState<string | null>(null),
    [start, setStart] = useState(
      () =>
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('search') === '1',
    ),
    [help, setHelp] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [previewGroup, setPreviewGroup] = useState<
    string | null
  >(null);
  const windowSources = useRef(new Map<string, HTMLDivElement>());
  const [bounds, setBounds] = useState<DesktopBounds>({
    width: 1280,
    height: 680,
  });
  const stage = useRef<HTMLDivElement>(null),
    sequence = useRef(1),
    mutationLock = useRef(false);
  const drag = useRef<{
    id: string;
    mode: 'move' | 'resize';
    x: number;
    y: number;
    rect: WindowRect;
  } | null>(null);
  const dirty = windows.some((w) => w.dirty),
    active = activeWindow(windows);

  useEffect(() => {
    const controller = new AbortController();
    void api<VersionCapabilities>('/versions/capabilities', {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setVersionCapability(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setVersionCapability(null);
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    void read<Capabilities>('/files/capabilities', controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setCap(data);
        if (data.available && !initialRepoRequest.current && (initialFileRequest.current || new URLSearchParams(window.location.search).get('task')==='resources')) {
          const task = new URLSearchParams(window.location.search).get('task');
          const initialKind = !initialFileRequest.current && task === 'resources' ? 'tasks' : 'folder';
          const path = initialFileRequest.current?.path || (initialKind === 'tasks' ? '@tasks' : data.defaultPath || '/');
          if(initialFileRequest.current)handledFileRequest.current=initialFileRequest.current.id;
          setWindows([
            {
              id: 'desktop-1',
              order: 1,
              kind: initialKind,
              path,
              initialPath: path,
              dirty: false,
              ...initialWindowState({
                width: stage.current?.clientWidth || 1280,
                height: stage.current?.clientHeight || 680,
              }),
            },
          ]);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [read]);
  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setBounds({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cap?.available]);
  useEffect(() => {
    const first = setTimeout(() => setNow(new Date()), 0);
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    onBusy(busy || dirty);
  }, [busy, dirty, onBusy]);
  useEffect(() => {
    if (!busy && !dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy, dirty]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPreviewGroup(null);
        setStart((value) => !value);
        return;
      }
      if (e.key === 'Escape') {
        if (previewGroup) {
          setPreviewGroup(null);
          return;
        }
        if (
          e.defaultPrevented ||
          (e.target instanceof Element && e.target.closest('[role="menu"]')) ||
          document.querySelector('[role="menu"]')
        )
          return;
        if (start) {
          setStart(false);
          return;
        }
        setStart(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [start, previewGroup]);

  async function mutate(request: Record<string, unknown>) {
    if (mutationLock.current)
      throw new Error('Bir dosya işlemi sürüyor. Tamamlanmasını bekleyin.');
    mutationLock.current = true;
    setWriting(true);
    try {
      const result = await api<{ message: string }>('/files/action', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      setGeneration((n) => n + 1);
      onMessage(result.message);
      return result;
    } finally {
      mutationLock.current = false;
      setWriting(false);
    }
  }
  const setDirty = useCallback(
    (id: string, value: boolean) =>
      setWindows((current) =>
        current.map((w) =>
          w.id === id && w.dirty !== value ? { ...w, dirty: value } : w,
        ),
      ),
    [],
  );
  function patch(id: string, changes: Partial<DesktopWindow>) {
    setWindows((current) =>
      current.map((w) => (w.id === id ? { ...w, ...changes } : w)),
    );
  }
  function focus(id: string) {
    setWindows((current) => focusWindow(current, id));
  }
  const open=useCallback((kind: DesktopWindow['kind'], path: string, entry?: Entry) => {
    if (['folder','file','trash'].includes(kind) && !cap.available) {
      onMessage(error || cap.reason || 'Bu sunucuda dosya erişimi kullanılamıyor.');
      return;
    }
    setPreviewGroup(null);
    setStart(false);
    const item: LaunchItem =
      kind === 'tool' ? launcherActions.find(item=>item.view===path)! : kind === 'applications' ? path==='@applications'?{id:'applications',kind:'applications',label:'Uygulamalar'}:{id:`project:${path}`,kind:'project',projectId:path,label:flattenProjects(groupProjects(apps)).find(project=>project.id===path)?.name || 'Uygulama'} : kind === 'repo'
        ? { id: 'repo', kind: 'repo', label: 'Repo Merkezi' }
        : kind === 'tasks'
          ? { id: 'tasks', kind: 'tasks', label: 'Görev Yöneticisi' }
          : kind === 'trash'
            ? { id: 'trash', kind: 'trash', label: 'Çöp kutusu' }
            : fileItem(path, kind, entry?.name);
    const existing = windows.find((w) => w.kind === kind && w.path === path);
    if (existing) {
      remember(item);
      setWindows(current=>focusWindow(current.map(window=>window.id===existing.id && kind==='applications'?{...window,launchRevision:(window.launchRevision || 0)+1}:window),existing.id));
      return;
    }
    if (windows.length >= 12) {
      onMessage(
        'En fazla 12 pencere açılabilir. Kullanmadığınız bir pencereyi kapatın.',
      );
      return;
    }
    remember(item);
    const order = ++sequence.current;
    setWindows((current) => [
      ...current,
      {
        id: `desktop-${order}`,
        order,
        kind,
        path,
        initialPath: path,
        entry,
        dirty: false,
        ...initialWindowState(
          bounds,
          kind === 'file' || kind === 'trash' ? 880 : 1120,
          current.length,
        ),
      },
    ]);
  },[windows,onMessage,remember,bounds,apps,cap.available,cap.reason,error]);
  useEffect(()=>{
    let current=true;
    queueMicrotask(()=>{
      if(!current || !navigationRequest || handledNavigation.current===navigationRequest.id)return;
      handledNavigation.current=navigationRequest.id;
      if(navigationRequest.view==='apps' || navigationRequest.view==='managed')open('applications','@applications');
      else open('tool',navigationRequest.view);
    });
    return ()=>{current=false;};
  },[navigationRequest,open]);
  useEffect(()=>{if(cap?.available && fileRequest && handledFileRequest.current!==fileRequest.id){handledFileRequest.current=fileRequest.id;open('folder',fileRequest.path);}},[cap?.available,fileRequest,open]);
  useEffect(()=>{
    if(versionCapability?.available && repoRequest && handledRepoRequest.current!==repoRequest.id){
      handledRepoRequest.current=repoRequest.id;
      setRequestedRepoPath({...repoRequest,id:++repoSequence.current});
      setRequestedRepoId(null);
      open('repo','@repo');
    }
  },[versionCapability?.available,repoRequest,open]);
  function openProjectRepo(path:string){
    setRequestedRepoPath({id:++repoSequence.current,path});
    setRequestedRepoId(null);
    open('repo','@repo');
  }
  function activate(item: LaunchItem) {
    if (item.kind === 'link') { remember(item); setStart(false); setPreviewGroup(null); return; }
    const reason = shortcutUnavailable(item);
    if (reason) { onMessage(reason); return; }
    if(item.kind==='applications' || item.kind==='project' || item.kind==='action' && (item.view==='managed' || item.view==='apps')){open('applications',item.projectId || '@applications');return;}
    if (item.kind === 'repo') {
      if (versionCapability?.available) open('repo', '@repo');
      return;
    }
    if (item.kind === 'tasks') {
      open('tasks', '@tasks');
      return;
    }
    if (item.kind === 'folder' || item.kind === 'file') {
      open(item.kind, item.path!, launcherEntry(item));
      return;
    }
    if (item.kind === 'trash') {
      open('trash', '@trash');
      return;
    }
    if (item.kind === 'action' && item.view) {
      open('tool',item.view);
      return;
    }
    const app = apps.find((a) => a.port === item.port);
    if (app) {
      preferences.remember(item);
      setStart(false);
      if(app.project)open('applications',app.project.id);
      else onApp(app);
    }
  }
  function close(id: string, force = false) {
    setPreviewGroup(null);
    if (mutationLock.current || busy) return;
    if (!force && windows.find((w) => w.id === id)?.dirty) {
      setDiscard(id);
      focus(id);
      return;
    }
    setWindows((current) => current.filter((w) => w.id !== id));
    setDiscard(null);
  }
  function maximize(w: DesktopWindow) {
    patch(w.id, { maximized: !w.maximized });
    focus(w.id);
  }
  function beginDrag(
    e: PointerEvent<HTMLElement>,
    w: DesktopWindow,
    mode: 'move' | 'resize',
  ) {
    if (
      e.button !== 0 ||
      w.maximized ||
      bounds.width < 760 ||
      (mode === 'move' && (e.target as HTMLElement).closest('button'))
    )
      return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: w.id,
      mode,
      x: e.clientX,
      y: e.clientY,
      rect: clampWindow(w.rect, bounds),
    };
  }
  function moveDrag(e: PointerEvent<HTMLElement>) {
    const value = drag.current;
    if (!value) return;
    const dx = e.clientX - value.x,
      dy = e.clientY - value.y;
    const rect =
      value.mode === 'move'
        ? { ...value.rect, x: value.rect.x + dx, y: value.rect.y + dy }
        : {
            ...value.rect,
            width: Math.min(bounds.width - value.rect.x, value.rect.width + dx),
            height: Math.min(
              bounds.height - value.rect.y,
              value.rect.height + dy,
            ),
          };
    patch(value.id, { rect: clampWindow(rect, bounds) });
  }

  const projects = flattenProjects(groupProjects(apps));
  const action = (id: string) => launcherActions.find(item => item.id === id)!;
  const defaultDock: LaunchItem[] = [action('applications'), action('action:models'), action('action:credentials'),
    ...(cap.available ? [fileItem('/', 'folder')] : []), action('tasks'), ...(versionCapability?.available ? [action('repo')] : []), ...(cap.available ? [{ id: 'trash', kind: 'trash' as const, label: 'Çöp kutusu' }] : [])];
  const defaultDesktop = [action('applications'), action('action:servers'), action('action:models')];
  const availableShortcuts: LaunchItem[] = [...launcherActions.filter(item => !['action:apps', 'action:managed'].includes(item.id)),
    ...projects.map(project => ({ id: `project:${project.id}`, kind: 'project' as const, projectId: project.id, label: project.name })),
    ...(cap.available ? [...new Set(['/', ...cap.roots])].map(path => fileItem(path, 'folder')) : []),
    ...(cap.available ? [{ id: 'trash', kind: 'trash' as const, label: 'Çöp kutusu' }] : [])];
  function shortcutUnavailable(item: LaunchItem): string {
    if (['folder', 'file', 'trash'].includes(item.kind) && !cap.available) return 'Bu sunucuda dosya erişimi kullanılamıyor.';
    if (item.kind === 'repo' && !versionCapability?.available) return 'Bu sunucuda Repo Merkezi kullanılamıyor.';
    if (item.kind === 'project' && !projects.some(project => project.id === item.projectId)) return 'Bu uygulama mevcut sunucu envanterinde bulunamadı.';
    if (item.kind === 'app' && !apps.some(app => app.port === item.port)) return 'Bu uygulama mevcut sunucu envanterinde bulunamadı.';
    return '';
  }
  function windowTarget(item: LaunchItem): { kind: DesktopWindow['kind']; path: string } | null {
    if (item.kind === 'link') return null;
    if (item.kind === 'action') return ['apps', 'managed'].includes(item.view!) ? { kind: 'applications', path: '@applications' } : { kind: 'tool', path: item.view! };
    if (item.kind === 'applications' || item.kind === 'project') return { kind: 'applications', path: item.projectId || '@applications' };
    if (item.kind === 'app') { const app = apps.find(entry => entry.port === item.port); return app?.project ? { kind: 'applications', path: app.project.id } : null; }
    return { kind: item.kind, path: item.path || `@${item.kind}` };
  }
  type DockEntry = { key: string; item: LaunchItem; kind: DesktopWindow['kind'] | null; windowIds: string[] };
  const claimedWindows = new Set<string>();
  const dockItems: DockEntry[] = (desktopLayout.layout?.dock ?? defaultDock).map(item => {
    const target = windowTarget(item);
    const matching = target ? windows.filter(w => w.kind === target.kind && (w.kind === 'folder' ? w.initialPath : w.path) === target.path && !claimedWindows.has(w.id)) : [];
    matching.forEach(w => claimedWindows.add(w.id));
    return { key: item.id, item, kind: target?.kind || null, windowIds: matching.map(w => w.id) };
  });
  for (const w of windows) {
    if (claimedWindows.has(w.id)) continue;
    const key = `open:${w.kind}:${w.kind === 'tool' ? w.path : ''}`;
    const previous = dockItems.find(entry => entry.key === key);
    if (previous) { previous.windowIds.push(w.id); continue; }
    const item: LaunchItem = w.kind === 'tool' ? launcherActions.find(entry => entry.view === w.path)! : w.kind === 'applications' ? action('applications') : w.kind === 'folder' || w.kind === 'file' ? fileItem(w.initialPath, w.kind, w.kind === 'folder' ? 'Dosya Gezgini' : 'Dosya Görüntüleyici') : { id: w.kind, kind: w.kind, label: nameOf(w) };
    dockItems.push({ key, item, kind: w.kind, windowIds: [w.id] });
  }
  const desktopShortcuts = desktopLayout.layout?.desktop ?? defaultDesktop;
  function editLayout() { setPreviewGroup(null); setStart(false); setCustomizing(true); }
  const previews: PreviewWindow[] = windows.map((w) => {
    const rect =
      w.maximized || bounds.width < 760 ? bounds : clampWindow(w.rect, bounds);
    return {
      id: w.id,
      title: nameOf(w),
      path: w.path,
      kind: w.kind,
      minimized: w.minimized,
      dirty: w.dirty,
      width: Math.max(1, rect.width - 2),
      height: Math.max(1, rect.height - 40),
    };
  });
  return (
    <section
      className="desktop-shell expanded"
      aria-label={`${host} masaüstü`}
    >
      <div
        className={`desktop-topline ${copiedPath?.serverId === serverId ? 'has-copied-path' : ''}`}
      >
        <div>
          <DropdownMenu>
            <DropdownMenuTrigger className="desktop-system-menu" aria-label="ViiOS menüsü"><ViiBrandIcon/><strong>ViiOS</strong></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="desktop-menu-content">
              <div className="desktop-menu-label">Çalışma alanı</div>
              <DropdownMenuItem onClick={()=>open('applications','@applications')}><Grid2X2/>Uygulamalar</DropdownMenuItem>
              {launcherActions.filter(item=>item.kind==='action' && !['apps','managed'].includes(item.view!)).map(item=><DropdownMenuItem key={item.id} onClick={()=>activate(item)}><ToolIcon view={item.view!}/>{item.label}</DropdownMenuItem>)}
              {versionCapability?.available && <DropdownMenuItem disabled={busy || dirty} onClick={()=>setVersions({})}><FolderGit2/>Sürüm Yönetimi</DropdownMenuItem>}
              <DropdownMenuSeparator/>
              <DropdownMenuItem onClick={()=>onHistory(null)}><History/>İşlem geçmişi</DropdownMenuItem>
              <DropdownMenuItem onClick={onNotifications}><Bell/>Bildirimler{notificationCount>0?` (${notificationCount})`:''}</DropdownMenuItem>
              <DropdownMenuItem onClick={editLayout}><Settings2/>Masaüstünü düzenle</DropdownMenuItem>
              <DropdownMenuItem onClick={()=>setHelp(true)}><CircleHelp/>Masaüstü rehberi</DropdownMenuItem>
              <DropdownMenuSeparator/>
              <DropdownMenuItem disabled={busy || dirty || controlBusy} onClick={onLogout}><LogOut/>Oturumu kapat</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button className="desktop-host" title="Sunucu seçimi ve bağlantı durumu" onClick={()=>open('tool','servers')}><Server size={14}/><span>{host}</span></button>
        </div>
        {copiedPath?.serverId === serverId && (
          <output
            className="desktop-copied-path"
            aria-label="Son kopyalanan yol"
          >
            <Copy size={14} aria-hidden="true" />
            <span>Kopyalanan yol</span>
            <code title={copiedPath.path}>{copiedPath.path}</code>
            <button
              type="button"
              title="Yol bilgisini gizle"
              aria-label="Kopyalanan yol bilgisini gizle"
              onClick={() => setCopiedPath(null)}
            >
              <X size={14} />
            </button>
          </output>
        )}
        <div>
          {busy ? (
            <span className="desktop-state">
              <RefreshCw className="spin" size={14} />
              İşlem sürüyor
            </span>
          ) : dirty ? (
            <span className="desktop-state">Kaydedilmemiş dosyalar var</span>
          ) : (
            <span className="desktop-state">{windows.length} açık pencere</span>
          )}
          <div className="desktop-clock" aria-label="Tarih ve saat">
            <span>{now?.toLocaleDateString('tr-TR') || ''}</span>
            <strong>{now?.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) || '—'}</strong>
          </div>
          <button type="button" title="Uygulamaları yeniden tara" aria-label="Uygulamaları yeniden tara" disabled={scanning || busy || controlBusy} onClick={onScan}><RefreshCw size={17} className={scanning?'spin':''}/></button>
          <button type="button" className="desktop-notifications" title="Bildirimler" aria-label={notificationCount?`Bildirimler · ${notificationCount} okunmamış`:'Bildirimler'} onClick={onNotifications}><Bell size={17}/>{notificationCount>0 && <b>{notificationCount>99?'99+':notificationCount}</b>}</button>
          <Appearance/>
          <button
            title="Masaüstü nasıl kullanılır?"
            aria-label="Masaüstü nasıl kullanılır?"
            onClick={() => {
              setPreviewGroup(null);
              setHelp(true);
            }}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </div>
      <div
        className="desktop-stage"
        data-wallpaper={wallpaper}
        ref={stage}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setStart(false);
        }}
      >
        <div className="desktop-wallpaper" aria-hidden="true">
          <div />
          <div />
          <div />
        </div>
        {(connectionError || !cap.available) && <output className="desktop-access-status"><ShieldCheck size={16}/><span>{connectionError || error || cap.reason}</span><button onClick={()=>open('tool','servers')}>Sunucular</button></output>}
        {cap.available && cap.roots.length > 0 && (
          <div className="desktop-folders" aria-label="Klasörler">
            {cap.roots.map((path) => (
              <button
                key={path}
                className="desktop-shortcut"
                title={`${path === '/home' ? 'Ana klasör' : path.slice(1)} · Yeni pencerede aç`}
                onClick={() => open('folder', path)}
              >
                <span className="ui-icon desktop-shortcut-icon" aria-hidden="true"><Folder /></span>
                <span>{path === '/home' ? 'Ana klasör' : path.slice(1)}</span>
              </button>
            ))}
          </div>
        )}
        {!windows.some((w) => !w.minimized) && (
          <div className="desktop-welcome">
            <span className="vii-brand-tile desktop-welcome-icon" aria-hidden="true"><ViiBrandIcon/></span>
            <h1>ViiOS</h1><p>Visual Infrastructure Intelligence</p>
            <button
              type="button"
              className="desktop-search-bar"
              aria-label="Uygulama ve dosya ara"
              aria-haspopup="dialog"
              aria-expanded={start}
              title="Ara (Ctrl + K)"
              onClick={() => {
                setPreviewGroup(null);
                setStart(true);
              }}
            >
              <Search size={19} />
              <span>Uygulama ve dosya ara…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <div className="desktop-primary-launchers">{desktopShortcuts.map(item => item.kind === 'link' ? <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => activate(item)}><ShortcutIcon item={item}/><span>{item.label}</span></a> : <Button key={item.id} disabled={!!shortcutUnavailable(item)} title={shortcutUnavailable(item) || item.label} onClick={() => activate(item)}><ShortcutIcon item={item}/><span>{item.label}</span></Button>)}<Button className="desktop-layout-edit" variant="outline" aria-label="Masaüstü kısayollarını düzenle" title="Kısayol ekle veya düzenle" onClick={editLayout}><Plus size={18}/></Button></div>
            {desktopLayout.error && <p className="desktop-layout-error">{desktopLayout.error}<button onClick={() => { void desktopLayout.reload(); }}>Yeniden dene</button></p>}
          </div>
        )}
        {[...windows]
          .sort((a, b) => a.order - b.order)
          .map((w) => {
            const index = windows.findIndex((item) => item.id === w.id);
            const rect =
              w.maximized || bounds.width < 760
                ? { x: 0, y: 0, ...bounds }
                : clampWindow(w.rect, bounds);
            return (
              <section
                key={w.id}
                className={`desktop-window ${active === w.id ? 'active' : ''} ${w.maximized ? 'maximized' : ''}`}
                aria-label={`${nameOf(w)} penceresi`}
                hidden={w.minimized}
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  zIndex: index + 2,
                }}
                onPointerDownCapture={() => {
                  focus(w.id);
                  setStart(false);
                }}
                onFocusCapture={() => focus(w.id)}
              >
                <div
                  className="desktop-titlebar"
                  tabIndex={0}
                  role="toolbar"
                  aria-label={`${nameOf(w)} pencere başlığı. Taşımak için sürükleyin veya ok tuşlarını kullanın.`}
                  onDoubleClick={(e) => {
                    if (!(e.target as HTMLElement).closest('button'))
                      maximize(w);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.target !== e.currentTarget ||
                      ![
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown',
                      ].includes(e.key) ||
                      w.maximized
                    )
                      return;
                    e.preventDefault();
                    patch(w.id, {
                      rect: clampWindow(
                        {
                          ...rect,
                          x:
                            rect.x +
                            (e.key === 'ArrowLeft'
                              ? -20
                              : e.key === 'ArrowRight'
                                ? 20
                                : 0),
                          y:
                            rect.y +
                            (e.key === 'ArrowUp'
                              ? -20
                              : e.key === 'ArrowDown'
                                ? 20
                                : 0),
                        },
                        bounds,
                      ),
                    });
                  }}
                  onPointerDown={(e) => beginDrag(e, w, 'move')}
                  onPointerMove={moveDrag}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                  }}
                  onLostPointerCapture={() => {
                    drag.current = null;
                  }}
                >
                  <span className={`ui-icon window-app-icon ${w.kind}`}>
                    <WindowIcon kind={w.kind} path={w.path} />
                  </span>
                  <span className="window-title">
                    {nameOf(w)}
                    {w.dirty && <b title="Kaydedilmemiş değişiklikler"> ●</b>}
                  </span>
                  <span className="window-app-name">
                    {w.kind === 'folder'
                      ? 'Dosya Gezgini'
                      : w.kind === 'file'
                        ? 'Dosya Görüntüleyici'
                        : ''}
                  </span>
                  <div className="window-controls">
                    <button
                      title="Küçült"
                      aria-label={`${nameOf(w)} penceresini küçült`}
                      onClick={() => patch(w.id, { minimized: true })}
                    >
                      <Minus size={16} />
                    </button>
                    <button
                      title={w.maximized ? 'Önceki boyut' : 'Büyüt'}
                      aria-label={`${nameOf(w)} penceresini ${w.maximized ? 'eski boyutuna getir' : 'büyüt'}`}
                      onClick={() => maximize(w)}
                    >
                      {w.maximized ? (
                        <PanelsTopLeft size={14} />
                      ) : (
                        <Square size={13} />
                      )}
                    </button>
                    <button
                      className="window-close"
                      title="Kapat"
                      disabled={busy}
                      aria-label={`${nameOf(w)} penceresini kapat`}
                      onClick={() => close(w.id)}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>
                <div
                  className="desktop-window-body"
                  ref={(node) => {
                    if (node) windowSources.current.set(w.id, node);
                    else windowSources.current.delete(w.id);
                  }}
                >
                  {w.kind === 'tool' && <div className={`desktop-tool-panel desktop-tool-${w.path}`}>{renderPanel(w.path as DesktopView,active===w.id && !w.minimized)}</div>}
                  {w.kind === 'applications' && <ProjectApps key={`${w.id}:${w.launchRevision || 0}`} visible={active===w.id && !w.minimized} inventory={inventory} busy={controlBusy || busy} onAction={onAction} onSelect={onApp} onHistory={onHistory} onFiles={path=>open('folder',path)} onRepo={openProjectRepo} repoAvailable={!!versionCapability?.available} initialProjectId={w.initialPath==='@applications'?undefined:w.initialPath}/>}
                  {w.kind === 'tasks' && (
                    <TaskManager
                      host={host}
                      apps={apps}
                      visible={!w.minimized}
                      onInspect={onApp}
                      onStorage={()=>open('tool','storage')}
                    />
                  )}
                  {w.kind === 'repo' && (
                    <RepoCenter
                      apps={apps}
                      visible={active===w.id && !w.minimized}
                      capability={versionCapability}
                      generation={generation}
                      requestedProjectId={requestedRepoId}
                      requestedPath={requestedRepoPath}
                      onManage={(path) => setVersions(path ? { path } : {})}
                      onBusy={setVersionBusy}
                      onChanged={() => setGeneration((value) => value + 1)}
                    />
                  )}
                  {w.kind === 'folder' && (
                    <FileExplorer
                      host={host}
                      cap={cap}
                      initialPath={w.initialPath}
                      clipboard={clipboard}
                      setClipboard={setClipboard}
                      onPathCopied={(path) => setCopiedPath({ serverId, path })}
                      generation={generation}
                      locked={busy}
                      mutate={mutate}
                      onMessage={onMessage}
                      onPreparing={(value) =>
                        setPreparing((current) => ({
                          ...current,
                          [w.id]: value,
                        }))
                      }
                      onOpen={(entry) =>
                        open(
                          entry.kind === 'directory' ? 'folder' : 'file',
                          entry.path,
                          entry,
                        )
                      }
                      onPath={(path) => patch(w.id, { path })}
                      onTrash={() => open('trash', '@trash')}
                      onVersion={
                        versionCapability?.available && !dirty
                          ? (path) => setVersions({ path })
                          : undefined
                      }
                    />
                  )}
                  {w.kind === 'file' && w.entry && (
                    <FileDocument
                      windowId={w.id}
                      entry={w.entry}
                      locked={busy}
                      mutate={mutate}
                      onDirty={setDirty}
                    />
                  )}
                  {w.kind === 'trash' && (
                    <FileTrash
                      generation={generation}
                      locked={busy}
                      mutate={mutate}
                    />
                  )}
                </div>
                {!w.maximized && (
                  <button
                    className="window-resize"
                    aria-label={`${nameOf(w)} pencere boyutunu değiştir`}
                    title="Boyutlandırmak için sürükleyin veya ok tuşlarını kullanın"
                    onPointerDown={(e) => beginDrag(e, w, 'resize')}
                    onPointerMove={moveDrag}
                    onPointerUp={() => {
                      drag.current = null;
                    }}
                    onPointerCancel={() => {
                      drag.current = null;
                    }}
                    onLostPointerCapture={() => {
                      drag.current = null;
                    }}
                    onKeyDown={(e) => {
                      if (
                        ![
                          'ArrowLeft',
                          'ArrowRight',
                          'ArrowUp',
                          'ArrowDown',
                        ].includes(e.key)
                      )
                        return;
                      e.preventDefault();
                      patch(w.id, {
                        rect: clampWindow(
                          {
                            ...rect,
                            width:
                              rect.width +
                              (e.key === 'ArrowRight'
                                ? 20
                                : e.key === 'ArrowLeft'
                                  ? -20
                                  : 0),
                            height:
                              rect.height +
                              (e.key === 'ArrowDown'
                                ? 20
                                : e.key === 'ArrowUp'
                                  ? -20
                                  : 0),
                          },
                          bounds,
                        ),
                      });
                    }}
                  />
                )}
              </section>
            );
          })}
        <DesktopSearch
          open={start}
          onClose={() => setStart(false)}
          host={host}
          cap={cap}
          apps={apps}
          pins={preferences.pins}
          recent={preferences.recent}
          onPin={preferences.pin}
          onClearRecent={preferences.clearRecent}
          onActivate={activate}
          navigationLocked={false}
          generation={generation}
          repoAvailable={versionCapability?.available === true}
        />
        <DesktopDock autoHide={windows.some(window => !window.minimized)} keepOpen={start || previewGroup !== null}>
          <div className="dock-item" data-dock-kind="search">
            <button
              type="button"
              className={`dock-button ${start ? 'active has-windows' : ''}`}
              aria-label="Başlat menüsü"
              aria-expanded={start}
              onClick={() => { setPreviewGroup(null); setStart(!start); }}
            >
              <span className="dock-icon dock-brand-icon" aria-hidden="true"><ViiBrandIcon/></span>
              <span className="dock-label" aria-hidden="true">Ara / Başlat</span>
            </button>
          </div>
          {dockItems.map(entry => (
            <div className="dock-item" data-dock-kind={entry.item.kind === 'action' ? entry.item.view : entry.item.kind === 'folder' && entry.item.path === '/' ? 'server' : entry.item.kind} key={entry.key}>
              {entry.item.kind === 'link' ? <a
                className="taskbar-tab dock-button"
                data-kind={entry.item.kind}
                href={entry.item.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${entry.item.label} uygulamasını aç`}
                onClick={() => activate(entry.item)}
              ><span className="dock-icon" aria-hidden="true"><ShortcutIcon item={entry.item}/></span><span className="dock-label" aria-hidden="true">{entry.item.label}</span></a> : !entry.kind || shortcutUnavailable(entry.item) && !entry.windowIds.length ? <button className="taskbar-tab dock-button" disabled={!!shortcutUnavailable(entry.item)} title={shortcutUnavailable(entry.item) || entry.item.label} aria-label={entry.item.label} onClick={() => activate(entry.item)}><span className="dock-icon" aria-hidden="true"><ShortcutIcon item={entry.item}/></span><span className="dock-label" aria-hidden="true">{entry.item.label}</span></button> : <TaskbarPreview
                dock
                kind={entry.kind}
                label={entry.item.label}
                icon={<ShortcutIcon item={entry.item}/>}
                windows={previews.filter(w => entry.windowIds.includes(w.id))}
                sources={windowSources}
                activeId={active}
                open={previewGroup === entry.key && !start && !discard && !help && !customizing}
                onOpenChange={value => setPreviewGroup(current => value ? entry.key : current === entry.key ? null : current)}
                onActivate={id => { setStart(false); focus(id); }}
                onMinimize={id => patch(id, { minimized: true })}
                onClose={close}
                onLaunch={() => activate(entry.item)}
                busy={busy}
              />}
            </div>
          ))}
          <div className="dock-item" data-dock-kind="customize"><button className="dock-button" aria-label="Dock kısayollarını düzenle" title="Kısayol ekle veya düzenle" onClick={editLayout}><span className="dock-icon" aria-hidden="true"><Plus/></span><span className="dock-label" aria-hidden="true">Düzenle</span></button></div>
        </DesktopDock>
      </div>
      {customizing && desktopLayout.layout && <DesktopCustomizer initial={desktopLayout.layout} defaults={{ dock: defaultDock, desktop: defaultDesktop }} available={availableShortcuts} unavailable={shortcutUnavailable} saving={desktopLayout.saving} error={desktopLayout.error} onSave={desktopLayout.save} onReload={desktopLayout.reload} onClose={() => setCustomizing(false)}/>}
      {customizing && !desktopLayout.layout && <Dialog open onOpenChange={setCustomizing}><DialogContent><DialogHeader><DialogTitle>Masaüstünü düzenle</DialogTitle><DialogDescription>{desktopLayout.loading ? 'Düzen yükleniyor…' : desktopLayout.error || 'Düzen henüz yüklenmedi.'}</DialogDescription></DialogHeader>{!desktopLayout.loading && <Button onClick={() => { void desktopLayout.reload(); }}>Yeniden dene</Button>}</DialogContent></Dialog>}
      <AlertDialog
        open={!!discard}
        onOpenChange={(value) => {
          if (!value) setDiscard(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kaydedilmemiş değişiklikler var</AlertDialogTitle>
            <AlertDialogDescription>
              {windows.find((w) => w.id === discard)?.path} dosyasındaki
              değişiklikleri kaydetmeden kapatmak istiyor musunuz?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Düzenlemeye dön</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (discard) close(discard, true);
              }}
            >
              Kaydetmeden kapat
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="desktop-help">
          <DialogHeader>
            <DialogTitle>Masaüstü nasıl kullanılır?</DialogTitle>
            <DialogDescription>
              {host} üzerindeki dosyalarınız, ayrı pencerelerde.
            </DialogDescription>
          </DialogHeader>
          <ol>
            <li>
              <b>Aç:</b> Dock’taki uygulamaya, masaüstündeki klasöre veya dosya adına tıklayın.
              Her öğe ayrı pencerede açılır. Zaten açıksa o pencere öne gelir.
            </li>
            <li>
              <b>Pencereler:</b> Başlık çubuğundan sürükleyin; sağ alt köşeden
              boyutlandırın. Başlığa çift tıklayınca büyür. − küçültür, □
              büyütür, × kapatır.
            </li>
            <li>
              <b>Dock:</b> Pencere açıkken yalnız üst kenarı görünür; fareyi alt kenara götürünce açılır. Pencereler Dock’un arkasında kalır. Simgeler fare yaklaştıkça büyür ve adları görünür. Aynı uygulamanın pencereleri tek simgede
              gruplanır. Birden fazla pencere varsa simgeye tıklamak
              önizlemeleri açar. Tek pencere varsa tıklamak pencereye geçer;
              etkin pencereye tekrar tıklamak küçültür. Diğer araçları ViiOS menüsünden veya Başlat aramasından açabilirsiniz.
            </li>
            <li>
              <b>Kısayollar:</b> Dock veya masaüstündeki + düğmesiyle uygulama ve web adresi ekleyebilir, adını değiştirebilir, sıralayabilir ve kaldırabilirsiniz. Düzen seçili sunucuya kaydedilir. Dışa aktar ve İçe aktar ile başka bir kuruluma taşıyabilirsiniz.
            </li>
            <li>
              <b>Pencere önizlemeleri:</b> Görev çubuğundaki simgenin üzerine
              gelin. Aynı uygulamanın pencereleri yan yana görünür; karta
              tıklayarak pencereye geçin, × ile kapatın. Küçültülmüş pencereler
              de görünür. Simge odaktayken ↑ önizlemelere geçer, Esc kapatır.
            </li>
            <li>
              <b>Görev Yöneticisi:</b> Dock’taki simgeden çalışan
              uygulamaları ve canlı CPU, RAM, disk kullanımını açın. Ad, port
              veya PID ile arayın; CPU/RAM sıralamasıyla en çok tüketen
              uygulamayı bulun. Ölçümler yaklaşık saniyede bir yenilenir.
              Duraklat düğmesi yalnız ölçümü duraklatır; uygulamaları durdurmaz.
            </li>
            <li>
              <b>Dosya işlemleri:</b> Öğenin kutusuyla seçin. Kopyala / Kes →
              başka bir klasör penceresi → Yapıştır. Yeni dosya, klasör, yükleme
              ve yeniden adlandırma araç çubuğundadır.
            </li>
            <li>
              <b>Özellikler:</b> Dosya veya klasöre sağ tıklayıp Özellikler
              seçin; seçili öğede Alt + Enter da kullanılabilir. Boyut, diskte
              ayrılan alan, klasör içeriği, tarihler, sahip ve izinler
              gösterilir. Boş alana sağ tıklamak bulunduğunuz klasörün
              özelliklerini açar.
            </li>
            <li>
              <b>Aktarım ve klonlama:</b> İçe aktar menüsünden Dosya yükle veya
              Klasör yükle seçin; dosya ve klasörleri pencereye de
              bırakabilirsiniz. Yüklemede boyut ve dosya sayısı sınırı yoktur,
              sıkıştırma gerekmez. Alt klasörler korunur; boş klasörler için
              sürükle-bırak kullanın. Dışa aktar, seçili dosya/klasörü boyut ve
              öğe sayısı sınırı olmadan ZIP olarak indirir. Gönderilen miktarı
              burada, indirmeyi tarayıcının İndirilenler bölümünde izleyin;
              İptal düğmesi aktarımı durdurur. Klonla (Ctrl + D), aynı klasörde
              yeni adla kopya oluşturur. Öğeye veya boş alana sağ tıklayarak
              ilgili işlem menüsünü açabilirsiniz.
            </li>
            <li>
              <b>Klavye:</b> Ctrl + C / X / V, F2 adlandırma, Delete çöp kutusu.
              Metin düzenlerken Ctrl + S kaydeder.
            </li>
            <li>
              <b>Taslaklar:</b> Küçültmek düzenlemeyi korur. Kaydedilmemiş
              dosyayı kapatırken sorulur; sunucu değiştirmek veya bölümden
              çıkmak için kaydedin ya da dosya penceresini kapatın.
            </li>
          </ol>
          <p>
            Gizli dosyalar ve simge / liste görünümü her klasör penceresinde
            ayrı seçilir. Yükleme ve ZIP dışa aktarım boyut sınırı olmadan
            yapılır. Metin düzenleme 1 MB, doğrudan önizleme/indirme 16 MB,
            klasör kopyalama/taşıma/çöp işlemleri 5000 öğe / 200 MB
            sınırındadır.
          </p>
        </DialogContent>
      </Dialog>
      {versions && versionCapability?.available && (
        <VersionPanel
          key={`${serverId}:${versions.path || ''}`}
          initialPath={versions.path}
          capability={versionCapability}
          apps={apps}
          onClose={() => setVersions(null)}
          onBusy={setVersionBusy}
          onChanged={() => setGeneration((value) => value + 1)}
          onFolder={(path) => open('folder', path)}
          onOpenOps={(id) => {
            setRequestedRepoPath(null);
            setRequestedRepoId(id);
            setVersions(null);
            open('repo', '@repo');
          }}
        />
      )}
      <span className="sr-only">Sunucu kimliği: {serverId}</span>
    </section>
  );
}
