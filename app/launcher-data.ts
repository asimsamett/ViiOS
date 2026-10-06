import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry } from './file-manager';
import type { App } from './types';

export type DesktopView = 'managed' | 'apps' | 'ports' | 'reports' | 'help' | 'endpoints' | 'people' | 'models' | 'servers' | 'credentials' | 'storage' | 'overview' | 'processes' | 'services' | 'history' | 'notifications' | 'versions' | 'guide' | 'appearance' | 'features';
export type LaunchItem = {
  id: string;
  kind: 'app' | 'folder' | 'file' | 'action' | 'trash' | 'tasks' | 'repo' | 'applications' | 'project' | 'link';
  label: string;
  detail?: string;
  path?: string;
  port?: number;
  projectId?:string;
  view?: DesktopView;
  url?: string;
  openedAt?: number;
};
export function newLinkId() {
  // getRandomValues also works on the HTTP intranet deployment.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `link:${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
export const launcherActions: LaunchItem[] = [
  {id:'action:features',kind:'action',label:'Özellik Rehberi',detail:'Tüm uygulamaların kullanım kitapçığı ve özellikleri',view:'features'},
  {id:'action:history',kind:'action',label:'İşlem geçmişi',detail:'Sunucu işlemleri ve olay kayıtları',view:'history'},
  {id:'action:notifications',kind:'action',label:'Bildirimler',detail:'Uyarılar ve okunmamış bildirimler',view:'notifications'},
  {id:'action:versions',kind:'action',label:'Sürüm Yönetimi',detail:'Dosya sürümleri ve geri yükleme',view:'versions'},
  {id:'action:guide',kind:'action',label:'Masaüstü rehberi',detail:'Pencereler, kısayollar ve Dock kullanımı',view:'guide'},
  {id:'action:appearance',kind:'action',label:'Görünüm',detail:'Tema ve duvar kâğıdı seçenekleri',view:'appearance'},
  {id:'action:services',kind:'action',label:'Servisler',detail:'Servis durumu, ba\u015flang\u0131\u00e7 ve y\u00f6netim',view:'services'},
  {id:'action:processes',kind:'action',label:'Süreç Yöneticisi',detail:'Süreçleri ara, incele ve sonlandır',view:'processes'},
  {id:'action:overview',kind:'action',label:'Sunucu Monitörü',detail:'CPU, bellek, disk I/O, ağ ve sistem bilgileri',view:'overview'},
  {id:'applications',kind:'applications',label:'Uygulamalar',detail:'Projeler, servisler, portlar ve dosyalar'},
  {id:'action:models',kind:'action',label:'Modeller',detail:'Model bağlantıları, çalışan modeller ve kullanım',view:'models'},
  {id:'action:credentials',kind:'action',label:'Uygulamalar ve Şifreler',detail:'Yönetim paneli adresleri, kullanıcı adları ve şifreler',view:'credentials'},
  {id:'action:endpoints',kind:'action',label:'Port Envanteri',detail:'Tüm portlar, önizlemeler, filtreler ve denetim notları',view:'endpoints'},
  {id:'action:people',kind:'action',label:'Kişiler',detail:'Proje ekipleri ve kişiler',view:'people'},
  {id:'action:servers',kind:'action',label:'Sunucular',detail:'Sunucu seçimi, bağlantı durumu ve tarama',view:'servers'},
  {id:'action:storage',kind:'action',label:'Depolama',detail:'Disk bölümleri, klasörler ve uygulamaların alan kullanımı',view:'storage'},
  {
    id: 'repo',
    kind: 'repo',
    label: 'Repo Merkezi',
    detail: 'Git depoları, sürümler ve dosya farkları',
  },
  {
    id: 'tasks',
    kind: 'tasks',
    label: 'Görev Yöneticisi',
    detail: 'Canlı CPU, RAM ve çalışan uygulamalar',
  },
  {
    id: 'action:managed',
    kind: 'action',
    label: 'Uygulama yönetimi',
    detail: 'Başlat, durdur, yeniden başlat',
    view: 'managed',
  },
  {
    id: 'action:apps',
    kind: 'action',
    label: 'Tüm uygulamalar',
    detail: 'Portlar ve uygulama önizlemeleri',
    view: 'apps',
  },
  {
    id: 'action:ports',
    kind: 'action',
    label: 'Boş portlar',
    detail: 'Kullanılabilir portları bulun',
    view: 'ports',
  },
  {
    id: 'action:reports',
    kind: 'action',
    label: 'Raporlar',
    detail: 'Denetim ve işlem kayıtları',
    view: 'reports',
  },
  {
    id: 'action:help',
    kind: 'action',
    label: 'Nasıl kullanılır?',
    detail: 'Yönetim paneli rehberi',
    view: 'help',
  },
];
export const foldSearch = (value: string) =>
  value
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
export const matchesSearch = (value: string, query: string) =>
  foldSearch(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => foldSearch(value).includes(word));
export function fileItem(
  path: string,
  kind: 'folder' | 'file',
  label?: string,
): LaunchItem {
  return {
    id: `${kind}:${path}`,
    kind,
    path,
    label:
      label ||
      (path === '/'
        ? 'Bu sunucu'
        : path === '/home'
          ? 'Ana klasör'
          : path.split('/').at(-1) || path),
    detail: path,
  };
}
export function launcherEntry(item: LaunchItem): Entry {
  return {
    name: item.label,
    path: item.path!,
    kind: item.kind === 'folder' ? 'directory' : 'file',
    size: null,
    modifiedAt: 0,
    mode: '',
    uid: 0,
    gid: 0,
    revision: '',
    accessible: true,
    mutable: false,
  };
}
export function cleanLaunchItem(value: unknown): LaunchItem | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<LaunchItem>;
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 255 || v.label.includes('\0')) return null;
  let item: LaunchItem | undefined;
  if(v.kind==='applications')item={id:'applications',kind:'applications',label:'Uygulamalar'};
  else if(v.kind==='project' && typeof v.projectId==='string' && v.projectId.length>0 && v.projectId.length<=4096 && !v.projectId.includes('\0'))item={id:`project:${v.projectId}`,kind:'project',projectId:v.projectId,label:v.label};
  else if (v.kind === 'tasks')
    item = { id: 'tasks', kind: 'tasks', label: 'Görev Yöneticisi' };
  else if (v.kind === 'repo')
    item = launcherActions.find((entry) => entry.id === 'repo');
  else if (v.kind === 'action')
    item = launcherActions.find((a) => a.view === v.view);
  else if (v.kind === 'link') {
    if (typeof v.id !== 'string' || !/^link:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id) || typeof v.url !== 'string' || v.url.length > 2048) return null;
    try {
      const target = new URL(v.url);
      if (!['http:', 'https:'].includes(target.protocol) || !target.hostname || target.username || target.password || /\p{Cc}/u.test(v.url) || target.href.length > 2048) return null;
      item = {id:v.id.toLowerCase(),kind:'link',label:v.label,url:target.href};
    } catch { return null; }
  }
  else if (
    v.kind === 'app' &&
    Number.isInteger(v.port) &&
    v.port! >= 1 &&
    v.port! <= 65535
  )
    item = { id: `app:${v.port}`, kind: 'app', port: v.port, label: v.label };
  else if (v.kind === 'trash')
    item = { id: 'trash', kind: 'trash', label: 'Çöp kutusu' };
  else if (
    (v.kind === 'folder' || v.kind === 'file') &&
    typeof v.path === 'string' &&
    (v.path.startsWith('/') || /^[a-z]:[\\/]/i.test(v.path) || /^\\\\[^\\]+\\[^\\]+/.test(v.path)) &&
    v.path.length <= 4096 &&
    !v.path.includes('\0')
  )
    item = fileItem(v.path, v.kind, v.label);
  return item
    ? {
        ...item,
        label: v.label.trim(),
        ...(typeof v.detail === 'string' && v.detail.length <= 4096 ? {detail:v.detail} : {}),
        ...(typeof v.openedAt === 'number' && Number.isFinite(v.openedAt) && v.openedAt >= 0
          ? { openedAt: v.openedAt }
          : {}),
      }
    : null;
}
type Preferences = { pins: LaunchItem[] | null; recent: LaunchItem[] };
const noApps: App[] = [];

export function normalizeLauncherItems(items: LaunchItem[], apps: App[]): LaunchItem[] {
  const projects = new Map<string, LaunchItem>();
  const ports = new Map<number, LaunchItem>();
  for (const app of apps) {
    const project = app.project || { id: `port:${app.port}`, name: app.name };
    const item: LaunchItem = {
      id: `project:${project.id}`,
      kind: 'project',
      projectId: project.id,
      label: project.name,
    };
    if (!projects.has(project.id)) projects.set(project.id, item);
    ports.set(app.port, projects.get(project.id)!);
  }
  const normalized = new Map<string, LaunchItem>();
  for (const item of items) {
    const resolved = item.kind === 'app'
      ? ports.get(item.port!) || item
      : item.kind === 'project'
        ? projects.get(item.projectId!) || item
        : item.kind === 'action' && (item.view === 'apps' || item.view === 'managed')
          ? launcherActions.find(action => action.id === 'applications')!
          : item;
    const current = normalized.get(resolved.id);
    if (!current) {
      normalized.set(resolved.id, {
        ...resolved,
        ...(item.openedAt === undefined ? {} : { openedAt: item.openedAt }),
      });
    } else if (item.openedAt !== undefined && (current.openedAt === undefined || item.openedAt > current.openedAt)) {
      normalized.set(resolved.id, { ...current, openedAt: item.openedAt });
    }
  }
  return [...normalized.values()];
}

export function toggleLauncherPin(pins: LaunchItem[], item: LaunchItem, apps: App[]): LaunchItem[] {
  const normalized = normalizeLauncherItems(pins, apps);
  const [target] = normalizeLauncherItems([item], apps);
  return normalized.some(pin => pin.id === target.id)
    ? normalized.filter(pin => pin.id !== target.id)
    : [...normalized, target].slice(-16);
}

export function useLauncherPreferences(serverId: string, apps: App[] = noApps) {
  const key = `management-launcher-v1:${serverId}`;
  const [prefs, setPrefs] = useState<Preferences>({ pins: null, recent: [] });
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const latest = useRef<Preferences>({ pins: null, recent: [] });
  const update = useCallback(
    (value: Preferences) => {
      latest.current = value;
      setPrefs(value);
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* Keep device preferences in this session. */
      }
    },
    [key],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const raw = localStorage.getItem(key);
        if (raw && raw.length < 100000) {
          const data = JSON.parse(raw);
          const items = (list: unknown, limit: number) =>
            Array.isArray(list)
              ? list
                  .map(cleanLaunchItem)
                  .filter((v): v is LaunchItem => !!v)
                  .filter(
                    (v, i, all) => all.findIndex((x) => x.id === v.id) === i,
                  )
                  .slice(0, limit)
              : [];
          const value = {
            pins: Array.isArray(data.pins) ? items(data.pins, 16) : null,
            recent: items(data.recent, 12),
          };
          latest.current = value;
          setPrefs(value);
        }
      } catch {
        /* Device preferences are optional in private browsing. */
      }
      setLoadedKey(key);
    }, 0);
    return () => clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    const current = latest.current;
    const normalized = {
      pins: current.pins === null ? null : normalizeLauncherItems(current.pins, apps),
      recent: normalizeLauncherItems(current.recent, apps),
    };
    if (JSON.stringify(normalized) !== JSON.stringify(current)) update(normalized);
  }, [apps, key, loadedKey, prefs, update]);
  const remember = useCallback(
    (item: LaunchItem) => {
      const current = latest.current;
      const [target] = normalizeLauncherItems([item], apps);
      update({
        ...current,
        recent: normalizeLauncherItems([
          { ...target, openedAt: Date.now() },
          ...current.recent,
        ], apps).slice(0, 12),
      });
    },
    [apps, update],
  );
  function pin(item: LaunchItem, defaults: LaunchItem[]) {
    const current = latest.current,
      pins = current.pins || defaults;
    update({
      ...current,
      pins: toggleLauncherPin(pins, item, apps),
    });
  }
  return {
    ...prefs,
    remember,
    pin,
    clearRecent: () => update({ ...latest.current, recent: [] }),
  };
}
