'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  Grid2X2,
  List,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Files,
  File,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderGit2,
  FolderPlus,
  HardDrive,
  Home,
  ImageIcon,
  Info,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTarget } from './target-context';
import { copyText, clientFetch as fetch } from './api';
import { useFileRead } from './file-read';
import FileProperties, { type PropertiesItem } from './file-properties';
import {
  filesToUpload,
  droppedUpload,
  sendUpload,
  type UploadItem,
} from './file-upload';

export type Capabilities = {
  available: boolean;
  roots: string[];
  defaultPath?: string;
  reason: string;
  textLimit?: number;
  fileLimit?: number;
  streamUpload?: boolean;
  streamExport?: boolean;
};
export type Entry = {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'link' | 'special';
  size: number | null;
  modifiedAt: number;
  mode: string;
  uid: number;
  gid: number;
  revision: string;
  accessible: boolean;
  mutable: boolean;
};
type Listing = {
  path: string;
  parent: string;
  entries: Entry[];
  total: number;
  offset: number;
  writable: boolean;
};
export type Viewed = {
  name: string;
  path: string;
  kind: 'text' | 'image' | 'binary';
  size: number;
  revision: string;
  editable: boolean;
  content?: string;
};
export type Clipboard = {
  serverId: string;
  entry: Entry;
  mode: 'copy' | 'move';
};
type Operation = {
  kind: 'create' | 'mkdir' | 'rename' | 'paste' | 'clone';
  entry?: Entry;
};
type TransferState = {
  kind: 'import' | 'export';
  total: number;
  completed: number;
  current: string;
  failures: { name: string; error: string }[];
  done: boolean;
  exportId?: string;
  phase?: string;
  sentBytes?: number;
  sourceBytes?: number | null;
  entries?: number | null;
};
const size = (n: number | null) =>
  n === null
    ? '—'
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1024 * 1024 * 1024
          ? `${(n / 1024 / 1024).toFixed(1)} MB`
          : `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
const date = (n: number) =>
  new Date(n).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const join = (path: string, name: string) =>
  `${path === '/' ? '' : path}/${name}`;
export function EntryIcon({ entry }: { entry: Entry }) {
  return !entry.accessible ? (
    <LockKeyhole size={20} />
  ) : entry.kind === 'directory' ? (
    <Folder size={22} />
  ) : /\.(png|jpg|jpeg|gif|webp)$/i.test(entry.name) ? (
    <ImageIcon size={20} />
  ) : /\.(py|js|ts|tsx|json|yml|yaml|md|html|css|sh|txt|log)$/i.test(
      entry.name,
    ) ? (
    <FileCode2 size={20} />
  ) : (
    <File size={20} />
  );
}

export default function FileExplorer({
  host,
  cap,
  initialPath,
  clipboard,
  setClipboard,
  onPathCopied,
  generation,
  locked,
  mutate,
  onMessage,
  onPreparing,
  onOpen,
  onPath,
  onTrash,
  onVersion,
}: {
  host: string;
  cap: Capabilities;
  initialPath: string;
  clipboard: Clipboard | null;
  setClipboard: React.Dispatch<React.SetStateAction<Clipboard | null>>;
  onPathCopied: (path: string) => void;
  generation: number;
  locked: boolean;
  mutate: (request: Record<string, unknown>) => Promise<unknown>;
  onMessage: (message: string) => void;
  onPreparing: (value: boolean) => void;
  onOpen: (entry: Entry) => void;
  onPath: (path: string) => void;
  onTrash: () => void;
  onVersion?: (path: string) => void;
}) {
  const { id: serverId, url, api } = useTarget();
  const read = useFileRead(),
    formId = useId();
  const [path, setPath] = useState(initialPath),
    [pathDraft, setPathDraft] = useState(initialPath),
    [display, setDisplay] = useState<'icons' | 'details'>('icons');
  const [listing, setListing] = useState<Listing | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [query, setQuery] = useState(''),
    [hidden, setHidden] = useState(false),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [properties, setProperties] = useState<PropertiesItem | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null),
    [newName, setNewName] = useState(''),
    [operationError, setOperationError] = useState('');
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [transfer, setTransfer] = useState<TransferState | null>(null),
    [dragging, setDragging] = useState(false),
    [contextEntry, setContextEntry] = useState<Entry | null>(null);
  const transferLock = useRef(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const upload = useRef<HTMLInputElement>(null),
    folderUpload = useRef<HTMLInputElement>(null),
    keyboardRoot = useRef<HTMLElement>(null);
  const busy = locked || (!!transfer && !transfer.done);
  useEffect(() => () => uploadAbort.current?.abort(), []);

  useEffect(() => {
    if (!cap?.available || locked || transferLock.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      void read<Listing>(
        `/files/list?${new URLSearchParams({ path, query, hidden: String(hidden), offset: String(offset) })}`,
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) {
            setListing(data);
            setSelected(null);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setListing(null);
            setError((e as Error).message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [read, cap, path, query, hidden, offset, refresh, generation, locked]);

  function navigate(next: string) {
    if (busy) return;
    setLoading(true);
    setPath(next);
    setPathDraft(next);
    onPath(next);
    setSelected(null);
    setQuery('');
    setOffset(0);
    setRefresh((n) => n + 1);
  }
  function refreshList() {
    setRefresh((n) => n + 1);
  }
  async function perform(request: Record<string, unknown>) {
    return await mutate(request);
  }
  function buffer(entry: Entry, mode: 'copy' | 'move') {
    setClipboard({ entry, mode, serverId });
    onMessage(
      `${entry.name} ${mode === 'copy' ? 'kopyalamak' : 'taşımak'} için seçildi. Hedef klasörde Yapıştır kullanın.`,
    );
  }
  function prompt(kind: Operation['kind'], entry?: Entry) {
    if (busy || loading) return;
    setOperation({ kind, entry });
    setOperationError('');
    let value =
      kind === 'rename'
        ? entry?.name || ''
        : kind === 'paste'
          ? clipboard?.entry.name || ''
          : '';
    if (
      kind === 'paste' &&
      clipboard?.mode === 'copy' &&
      clipboard.entry.path.split('/').slice(0, -1).join('/') === path
    ) {
      const dot = value.lastIndexOf('.');
      value =
        clipboard.entry.kind === 'file' && dot > 0
          ? value.slice(0, dot) + ' kopya' + value.slice(dot)
          : value + ' kopya';
    }
    if (kind === 'clone' && entry) {
      const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
      const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
      const extension = dot > 0 ? entry.name.slice(dot) : '';
      const names = new Set(listing?.entries.map((item) => item.name));
      let count = 1;
      do {
        value = `${stem} kopya${count === 1 ? '' : ' ' + count}${extension}`;
        count++;
      } while (names.has(value));
    }
    setNewName(value);
  }
  async function submit() {
    if (!operation) return;
    if (
      !newName.trim() ||
      newName === '.' ||
      newName === '..' ||
      newName.includes('/') ||
      newName.split('').some((c) => c.charCodeAt(0) < 32)
    ) {
      setOperationError('Geçerli bir dosya veya klasör adı girin.');
      return;
    }
    setOperationError('');
    try {
      const destination = join(path, newName);
      if (operation.kind === 'create' || operation.kind === 'mkdir')
        await perform({
          action: operation.kind,
          path: destination,
          ...(operation.kind === 'create' ? { content: '' } : {}),
        });
      else if (operation.kind === 'rename' && operation.entry)
        await perform({
          action: 'move',
          path: operation.entry.path,
          destination,
          revision: operation.entry.revision,
        });
      else if (operation.kind === 'clone' && operation.entry)
        await perform({
          action: 'copy',
          path: operation.entry.path,
          destination,
          revision: operation.entry.revision,
        });
      else if (
        operation.kind === 'paste' &&
        clipboard &&
        clipboard.serverId === serverId
      ) {
        await perform({
          action: clipboard.mode,
          path: clipboard.entry.path,
          destination,
          revision: clipboard.entry.revision,
        });
        if (clipboard.mode === 'move')
          setClipboard((current) => (current === clipboard ? null : current));
      }
      setOperation(null);
    } catch (e) {
      setOperationError((e as Error).message);
    }
  }
  async function remove() {
    if (!removing) return;
    try {
      await perform({
        action: 'trash',
        path: removing.path,
        revision: removing.revision,
      });
      setRemoving(null);
      setSelected(null);
    } catch (e) {
      setOperationError((e as Error).message);
    }
  }
  async function uploadFiles(
    prepare: () => UploadItem[] | Promise<UploadItem[]>,
  ) {
    if (transferLock.current || !writable || cap.streamUpload === false) return;
    const destination = path;
    const controller = new AbortController();
    uploadAbort.current = controller;
    transferLock.current = true;
    onPreparing(true);
    const failures: TransferState['failures'] = [];
    setTransfer({
      kind: 'import',
      total: 0,
      completed: 0,
      current: 'Dosya ve klasörler hazırlanıyor…',
      failures: [],
      done: false,
      phase: 'preparing',
    });
    try {
      const items = await prepare();
      const sourceBytes = items.reduce(
        (sum, item) => sum + (item.file?.size || 0),
        0,
      );
      setTransfer(
        (current) =>
          current && {
            ...current,
            total: items.length,
            sourceBytes,
            sentBytes: 0,
            phase: 'streaming',
          },
      );
      let sentBytes = 0;
      const failedDirectories = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        if (controller.signal.aborted) break;
        const item = items[i];
        setTransfer((current) => current && { ...current, current: item.path });
        try {
          if (
            Array.from(failedDirectories).some((folder) =>
              item.path.startsWith(folder + '/'),
            )
          )
            throw new Error('Üst klasör oluşturulamadığı için yüklenmedi.');
          if (item.file) {
            await sendUpload(
              url(
                '/files/upload?' +
                  new URLSearchParams({
                    path: join(destination, item.path),
                    size: String(item.file.size),
                  }),
              ),
              item.file,
              controller.signal,
              (bytes) =>
                setTransfer(
                  (current) =>
                    current && { ...current, sentBytes: sentBytes + bytes },
                ),
            );
            sentBytes += item.file.size;
          } else {
            await api('/files/action', {
              method: 'POST',
              signal: controller.signal,
              body: JSON.stringify({
                action: 'upload-directory',
                path: join(destination, item.path),
              }),
            });
          }
        } catch (e) {
          if (!item.file) failedDirectories.add(item.path);
          failures.push({ name: item.path, error: (e as Error).message });
        }
        setTransfer(
          (current) =>
            current && {
              ...current,
              completed: i + 1,
              sentBytes,
              failures: [...failures],
            },
        );
      }
      onMessage(
        controller.signal.aborted
          ? 'Yükleme iptal edildi. Tamamlanan dosyalar korundu.'
          : failures.length
            ? `Aktarım bitti; ${failures.length} öğe yüklenemedi. Ayrıntılar aktarım özetinde.`
            : 'Dosya ve klasörler yüklendi.',
      );
    } catch (e) {
      failures.push({ name: 'İçe aktarım', error: (e as Error).message });
      setTransfer(
        (current) => current && { ...current, failures: [...failures] },
      );
    } finally {
      setTransfer(
        (current) =>
          current && {
            ...current,
            current: '',
            done: true,
            phase: controller.signal.aborted ? 'cancelled' : 'complete',
          },
      );
      transferLock.current = false;
      uploadAbort.current = null;
      onPreparing(false);
      if (upload.current) upload.current.value = '';
      if (folderUpload.current) folderUpload.current.value = '';
      refreshList();
    }
  }
  async function exportEntry(entry: Entry) {
    if (transferLock.current || busy || loading || !entry.accessible || cap.streamExport === false) return;
    transferLock.current = true;
    onPreparing(true);
    setTransfer({
      kind: 'export',
      total: 1,
      completed: 0,
      current: entry.name,
      failures: [],
      done: false,
    });
    try {
      const response = await fetch(url('/files/exports'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Management-Request': '1',
        },
        body: JSON.stringify({ path: entry.path, revision: entry.revision }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || 'Dışa aktarım tamamlanamadı.');
      }
      const job = (await response.json()) as { id: string };
      setTransfer(
        (current) =>
          current && { ...current, exportId: job.id, phase: 'pending' },
      );
      const link = document.createElement('a');
      link.href = url(`/files/exports/${job.id}/download`);
      link.download = entry.name + '.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const progressResponse = await fetch(url(`/files/exports/${job.id}`));
        const progress = (await progressResponse.json()) as {
          state: string;
          sentBytes: number;
          sourceBytes: number | null;
          entries: number | null;
          error?: string;
        };
        if (!progressResponse.ok)
          throw new Error(
            progress.error ||
              'Aktarım durumu alınamadı. Tarayıcının İndirilenler bölümünü kontrol edin.',
          );
        setTransfer(
          (current) =>
            current && {
              ...current,
              phase: progress.state,
              sentBytes: progress.sentBytes,
              sourceBytes: progress.sourceBytes,
              entries: progress.entries,
            },
        );
        if (progress.state === 'complete') break;
        if (progress.state === 'failed' || progress.state === 'cancelled')
          throw new Error(progress.error || 'Dışa aktarım tamamlanamadı.');
      }
      setTransfer((current) => current && { ...current, completed: 1 });
      onMessage(
        `${entry.name}.zip sunucudan gönderildi. İndirmeyi tarayıcının İndirilenler bölümünden takip edebilirsiniz.`,
      );
    } catch (e) {
      setTransfer(
        (current) =>
          current && {
            ...current,
            failures: [{ name: entry.name, error: (e as Error).message }],
          },
      );
      onMessage((e as Error).message);
    } finally {
      setTransfer(
        (current) => current && { ...current, current: '', done: true },
      );
      transferLock.current = false;
      onPreparing(false);
    }
  }
  async function cancelExport() {
    if (!transfer?.exportId) return;
    try {
      const response = await fetch(
        url(`/files/exports/${transfer.exportId}/cancel`),
        { method: 'POST', headers: { 'X-Management-Request': '1' } },
      );
      if (!response.ok)
        throw new Error(
          'İptal isteği tamamlanamadı. Tarayıcıdan indirmeyi iptal edebilirsiniz.',
        );
    } catch (error) {
      onMessage((error as Error).message);
    }
  }
  const writable = !!listing?.writable && !loading && !busy;
  function selectContext(target: EventTarget | null) {
    const item =
      target instanceof Element
        ? target.closest<HTMLElement>('[data-entry-path]')
        : null;
    const entry =
      listing?.entries.find((e) => e.path === item?.dataset.entryPath) || null;
    setContextEntry(entry);
    setSelected(entry?.accessible ? entry : null);
  }
  function copyPath(entry?: Entry | null) {
    const copied = entry?.path || path;
    void copyText(copied)
      .then(() => {
        onPathCopied(copied);
        onMessage('Yol kopyalandı.');
      })
      .catch((e) => onMessage((e as Error).message));
  }
  function keyboard(e: KeyboardEvent) {
    if (
      busy ||
      loading ||
      (e.target as HTMLElement).closest(
        'input,textarea,[contenteditable="true"],[role="dialog"]',
      )
    )
      return;
    if (e.altKey && e.key === 'Enter' && selected) {
      e.preventDefault();
      setProperties(selected);
    } else if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'c' && selected?.accessible) {
        e.preventDefault();
        buffer(selected, 'copy');
      }
      if (e.key.toLowerCase() === 'x' && selected?.mutable) {
        e.preventDefault();
        buffer(selected, 'move');
      }
      if (e.key.toLowerCase() === 'v' && writable && clipboard) {
        e.preventDefault();
        prompt('paste');
      }
      if (e.key.toLowerCase() === 'd' && writable && selected?.accessible) {
        e.preventDefault();
        prompt('clone', selected);
      }
    } else if (e.key === 'F2' && selected?.mutable) {
      e.preventDefault();
      prompt('rename', selected);
    } else if (e.key === 'Delete' && selected?.mutable) {
      e.preventDefault();
      setOperationError('');
      setRemoving(selected);
    }
  }
  useEffect(() => {
    const root = keyboardRoot.current;
    root?.addEventListener('keydown', keyboard);
    return () => root?.removeEventListener('keydown', keyboard);
  });
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- File dropping supplements the keyboard-accessible import button.
    <section
      ref={keyboardRoot}
      className={`file-manager explorer-window ${dragging ? 'files-dragging' : ''}`}
      aria-label={`${host} dosya yöneticisi`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = writable && cap.streamUpload !== false ? 'copy' : 'none';
          setDragging(writable && cap.streamUpload !== false);
        }
      }}
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        if (!writable || cap.streamUpload === false) {
          onMessage(
            cap.streamUpload === false ? 'Bu sunucu bağlantısı dosya yüklemeyi desteklemiyor.' : 'Dosyaları yazılabilir bir klasöre bırakın; devam eden işlem varsa tamamlanmasını bekleyin.',
          );
          return;
        }
        const data = e.dataTransfer;
        void uploadFiles(() => droppedUpload(data));
      }}
    >
      {dragging && (
        <div className="files-drop-overlay">
          <Upload size={30} />
          <strong>Dosya ve klasörleri buraya bırakın</strong>
        </div>
      )}
      <div className="files-layout">
        <aside className="files-sidebar">
          <span>KONUMLAR</span>
          <Button
            variant="ghost"
            className={path === '/' ? 'active' : ''}
            disabled={busy}
            onClick={() => navigate('/')}
          >
            <HardDrive size={17} />
            Sunucu kökü
          </Button>
          {cap.roots.map((root) => (
            <Button
              key={root}
              variant="ghost"
              className={
                path === root || path.startsWith(root + '/') ? 'active' : ''
              }
              disabled={busy}
              onClick={() => navigate(root)}
            >
              <Folder size={17} />
              {root}
            </Button>
          ))}
          <Button variant="ghost" onClick={onTrash}>
            <Trash2 size={17} />
            Çöp kutusu
          </Button>
          <div className="files-policy">
            <Info size={17} />
            <p>{cap.reason}</p>
          </div>
        </aside>
        <div className="files-main">
          <div className="files-location">
            <Button
              variant="outline"
              size="icon"
              aria-label="Üst klasöre git"
              disabled={busy || path === '/'}
              onClick={() =>
                navigate(path.split('/').slice(0, -1).join('/') || '/')
              }
            >
              <ArrowLeft size={17} />
            </Button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                navigate(pathDraft);
              }}
            >
              <Input
                aria-label="Sunucudaki klasör yolu"
                value={pathDraft}
                disabled={busy}
                onChange={(e) => setPathDraft(e.target.value)}
              />
              <Button type="submit" variant="ghost" disabled={busy}>
                Git
              </Button>
            </form>
            <Button
              variant="outline"
              size="icon"
              aria-label="Klasörü yenile"
              disabled={busy || loading}
              onClick={refreshList}
            >
              <RefreshCw size={17} className={loading ? 'spin' : ''} />
            </Button>
          </div>
          <nav className="files-breadcrumbs" aria-label="Klasör yolu">
            <button
              disabled={busy}
              onClick={() => navigate('/')}
              aria-label="Sunucu kökü"
            >
              <Home size={15} />
            </button>
            {path
              .split('/')
              .filter(Boolean)
              .map((part, index, array) => (
                <span key={index}>
                  <ChevronRight size={13} />
                  <button
                    disabled={busy}
                    onClick={() =>
                      navigate('/' + array.slice(0, index + 1).join('/'))
                    }
                  >
                    {part}
                  </button>
                </span>
              ))}
          </nav>
          <div className="files-actions">
            {onVersion && (
              <Button
                variant="outline"
                disabled={busy || loading}
                onClick={() =>
                  onVersion(
                    selected?.kind === 'directory' ? selected.path : path,
                  )
                }
              >
                <FolderGit2 size={16} />
                Sürüm yönetimi
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!writable}
              onClick={() => prompt('create')}
            >
              <FilePlus2 size={16} />
              Yeni dosya
            </Button>
            <Button
              variant="outline"
              disabled={!writable}
              onClick={() => prompt('mkdir')}
            >
              <FolderPlus size={16} />
              Yeni klasör
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" disabled={!writable || cap.streamUpload === false} title={cap.streamUpload === false ? 'Bu bağlantıda dosya yükleme desteklenmiyor' : 'Dosya veya klasör yükle'} />}
              >
                <Upload size={16} /> İçe aktar
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-44">
                <DropdownMenuItem onClick={() => upload.current?.click()}>
                  <FilePlus2 /> Dosya yükle
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => folderUpload.current?.click()}>
                  <FolderPlus /> Klasör yükle
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              disabled={busy || loading || !selected?.accessible || cap.streamExport === false}
              title={cap.streamExport === false ? 'Bu bağlantıda ZIP dışa aktarma desteklenmiyor' : 'Seçili dosya veya klasörü ZIP olarak indir'}
              onClick={() => selected && void exportEntry(selected)}
            >
              <Download size={16} /> Dışa aktar
            </Button>
            <input
              ref={upload}
              type="file"
              multiple
              className="hidden"
              aria-label="İçe aktarılacak dosyaları seç"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) void uploadFiles(() => filesToUpload(files));
              }}
            />
            <input
              ref={folderUpload}
              type="file"
              multiple
              {...{ webkitdirectory: '' }}
              className="hidden"
              aria-label="Yüklenecek klasörü seç"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) void uploadFiles(() => filesToUpload(files));
              }}
            />
            <Button
              variant="outline"
              disabled={
                !writable || !clipboard || clipboard.serverId !== serverId
              }
              onClick={() => prompt('paste')}
            >
              <ClipboardPaste size={16} />
              Yapıştır
            </Button>
            <span className="files-action-divider" />
            <Button
              variant="ghost"
              disabled={!writable || !selected?.accessible}
              title="Seçili öğeyi aynı klasörde yeni adla çoğalt (Ctrl + D)"
              onClick={() => selected && prompt('clone', selected)}
            >
              <Files size={15} /> Klonla
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !selected?.accessible}
              onClick={() => selected && buffer(selected, 'copy')}
            >
              <Copy size={15} />
              Kopyala
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !selected?.mutable}
              onClick={() => selected && buffer(selected, 'move')}
            >
              <Scissors size={15} />
              Kes
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !selected?.mutable}
              onClick={() => selected && prompt('rename', selected)}
            >
              <Pencil size={15} />
              Adlandır
            </Button>
            <Button
              variant="ghost"
              className="file-remove"
              disabled={busy || !selected?.mutable}
              onClick={() => {
                setOperationError('');
                setRemoving(selected);
              }}
            >
              <Trash2 size={15} />
              Kaldır
            </Button>
            <Button
              variant="outline"
              disabled={loading}
              onClick={() =>
                setProperties(
                  selected || {
                    path,
                    name: path.split('/').at(-1) || 'Sunucu kökü',
                    kind: 'directory',
                  },
                )
              }
            >
              <Info size={15} /> Özellikler
            </Button>
          </div>
          <div className="files-transfer-hint">
            <Upload size={13} />
            <span>
              {cap.streamUpload === false ? 'Bu bağlantıda dosya yükleme ve ZIP dışa aktarma desteklenmiyor.' : 'Dosya veya klasörleri buraya sürükleyin ya da İçe aktar seçin · Sıkıştırma gerekmez'}
            </span>
          </div>
          {transfer && (
            <div
              className={`files-transfer ${transfer.failures.length ? 'has-errors' : ''}`}
            >
              <output>
                {transfer.done ? (
                  <Files size={16} />
                ) : (
                  <RefreshCw size={16} className="spin" />
                )}
                <span>
                  <strong>
                    {transfer.kind === 'import'
                      ? transfer.done
                        ? transfer.phase === 'cancelled'
                          ? 'İçe aktarım iptal edildi'
                          : transfer.failures.length
                            ? 'İçe aktarımda yüklenemeyen öğeler var'
                            : 'İçe aktarım tamamlandı'
                        : transfer.phase === 'preparing'
                          ? 'Klasör yapısı hazırlanıyor'
                          : 'Dosyalar yükleniyor'
                      : transfer.done
                        ? transfer.failures.length
                          ? 'Dışa aktarım tamamlanamadı'
                          : 'Sunucudan gönderim tamamlandı'
                        : transfer.phase === 'streaming'
                          ? 'ZIP gönderiliyor'
                          : 'ZIP hazırlanıyor'}
                  </strong>
                  <small>
                    {transfer.current ||
                      (transfer.kind === 'import'
                        ? `${Math.max(0, transfer.completed - transfer.failures.length)} başarılı · ${transfer.failures.length} yüklenemedi${transfer.total > transfer.completed ? ` · ${transfer.total - transfer.completed} bekleyen öğe yüklenmedi` : ''}`
                        : 'Dışa aktarım özeti')}
                    {!transfer.done && transfer.kind === 'import'
                      ? ` · ${transfer.completed} / ${transfer.total} öğe${transfer.sourceBytes != null ? ` · ${size(transfer.sentBytes || 0)} / ${size(transfer.sourceBytes)}` : ''}`
                      : ''}
                    {transfer.kind === 'export' && transfer.sourceBytes != null
                      ? ` · ${transfer.entries?.toLocaleString('tr-TR')} öğe · Kaynak ${size(transfer.sourceBytes)} · Gönderilen ${size(transfer.sentBytes || 0)}`
                      : ''}
                    {transfer.kind === 'export' &&
                    transfer.done &&
                    !transfer.failures.length
                      ? ' · Tarayıcının İndirilenler bölümünü kontrol edin.'
                      : ''}
                  </small>
                </span>
                {!transfer.done && transfer.kind === 'import' && (
                  <button
                    type="button"
                    aria-label="İçe aktarımı iptal et"
                    onClick={() => uploadAbort.current?.abort()}
                  >
                    <X size={15} /> İptal
                  </button>
                )}
                {!transfer.done &&
                  transfer.kind === 'export' &&
                  transfer.exportId && (
                    <>
                      {transfer.phase === 'pending' && (
                        <a
                          href={url(
                            `/files/exports/${transfer.exportId}/download`,
                          )}
                          download
                        >
                          İndirmeyi aç
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => void cancelExport()}
                        aria-label="Dışa aktarımı iptal et"
                      >
                        <X size={15} /> İptal
                      </button>
                    </>
                  )}
                {transfer.done && (
                  <button
                    aria-label="Aktarım özetini kapat"
                    onClick={() => setTransfer(null)}
                  >
                    <X size={15} />
                  </button>
                )}
              </output>
              {!transfer.done && (
                <progress
                  aria-label="Dosya aktarımı ilerlemesi"
                  max={
                    transfer.kind === 'import' && transfer.sourceBytes
                      ? transfer.sourceBytes
                      : Math.max(1, transfer.total)
                  }
                  value={
                    transfer.kind === 'import'
                      ? transfer.sourceBytes
                        ? transfer.sentBytes
                        : transfer.completed
                      : undefined
                  }
                />
              )}
              {!!transfer.failures.length && (
                <ul>
                  {transfer.failures.map((failure, i) => (
                    <li key={i}>
                      <b>{failure.name}:</b> {failure.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {clipboard && (
            <div className="files-clipboard">
              <ClipboardPaste size={15} />
              <span>
                <b>{clipboard.entry.name}</b> ·{' '}
                {clipboard.mode === 'copy' ? 'Kopyalanacak' : 'Taşınacak'} ·
                Hedef klasörü açıp Yapıştır seçin.
              </span>
              <button
                aria-label="Panoyu temizle"
                onClick={() => setClipboard(null)}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="files-filters">
            <div className="search-field">
              <Search size={16} />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOffset(0);
                }}
                placeholder="Bu klasörde ara…"
                aria-label="Bu klasörde dosya veya klasör ara"
              />
            </div>
            <label htmlFor={`${formId}-hidden`}>
              <Checkbox
                id={`${formId}-hidden`}
                checked={hidden}
                onCheckedChange={(value) => {
                  setHidden(value);
                  setOffset(0);
                }}
              />
              Gizli dosyalar
            </label>
            <div className="explorer-view-switch" aria-label="Dosya görünümü">
              <button
                aria-label="Büyük simgeler"
                title="Büyük simgeler"
                aria-pressed={display === 'icons'}
                onClick={() => setDisplay('icons')}
              >
                <Grid2X2 size={17} />
              </button>
              <button
                aria-label="Ayrıntılı liste"
                title="Ayrıntılı liste"
                aria-pressed={display === 'details'}
                onClick={() => setDisplay('details')}
              >
                <List size={18} />
              </button>
            </div>
          </div>
          {error && (
            <div className="notice error-notice" role="alert">
              <Info size={17} />
              {error}
            </div>
          )}
          <ContextMenu>
            <ContextMenuTrigger
              className="explorer-items"
              tabIndex={0}
              aria-label="Dosyalar; işlemler için sağ tıklayın"
              onContextMenuCapture={(e) => selectContext(e.target)}
              onPointerDownCapture={(e) => {
                if (e.pointerType === 'touch') selectContext(e.target);
              }}
              onKeyDownCapture={(e) => {
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))
                  selectContext(e.target);
              }}
            >
              {display === 'icons' ? (
                <div
                  className={`explorer-grid ${loading ? 'loading' : ''}`}
                  aria-busy={loading}
                >
                  {listing?.entries.map((entry) => (
                    <div
                      key={entry.path}
                      data-entry-path={entry.path}
                      className={`explorer-item ${selected?.path === entry.path ? 'selected' : ''} ${!entry.accessible ? 'protected' : ''}`}
                    >
                      <Checkbox
                        checked={selected?.path === entry.path}
                        disabled={!entry.accessible || busy || loading}
                        onCheckedChange={(value) =>
                          setSelected(value ? entry : null)
                        }
                        aria-label={`${entry.name} seç`}
                      />
                      <button
                        className={
                          entry.kind === 'directory' ? 'directory' : ''
                        }
                        title={`${entry.name} · ${entry.accessible ? 'Yeni pencerede aç' : 'Korumalı'}`}
                        disabled={!entry.accessible || busy || loading}
                        onClick={() => onOpen(entry)}
                      >
                        <EntryIcon entry={entry} />
                        <span>{entry.name}</span>
                        <small>
                          {!entry.accessible
                            ? 'Korumalı'
                            : entry.kind === 'directory'
                              ? 'Klasör'
                              : size(entry.size)}
                        </small>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className={`files-table ${loading ? 'loading' : ''}`}
                  aria-busy={loading}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="file-check" />
                        <TableHead>Ad</TableHead>
                        <TableHead>Boyut</TableHead>
                        <TableHead>Değiştirilme</TableHead>
                        <TableHead>İzinler</TableHead>
                        <TableHead className="file-open-heading">
                          İşlem
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {listing?.entries.map((entry) => (
                        <TableRow
                          key={entry.path}
                          data-entry-path={entry.path}
                          className={
                            selected?.path === entry.path ? 'selected' : ''
                          }
                        >
                          <TableCell>
                            <Checkbox
                              checked={selected?.path === entry.path}
                              disabled={!entry.accessible || busy || loading}
                              onCheckedChange={(value) =>
                                setSelected(value ? entry : null)
                              }
                              aria-label={`${entry.name} seç`}
                            />
                          </TableCell>
                          <TableCell>
                            <button
                              className={`file-name ${entry.kind === 'directory' ? 'directory' : ''}`}
                              disabled={!entry.accessible || busy || loading}
                              onClick={() => onOpen(entry)}
                            >
                              <EntryIcon entry={entry} />
                              <span>
                                {entry.name}
                                {!entry.accessible && (
                                  <small>Korumalı / bağlantı</small>
                                )}
                              </span>
                            </button>
                          </TableCell>
                          <TableCell>{size(entry.size)}</TableCell>
                          <TableCell className="file-date">
                            {date(entry.modifiedAt)}
                          </TableCell>
                          <TableCell>
                            <code>{entry.mode}</code>
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!entry.accessible || busy || loading}
                              onClick={() => onOpen(entry)}
                            >
                              {entry.kind === 'directory' ? 'Aç' : 'Görüntüle'}
                              <ChevronRight size={14} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {!loading && listing && !listing.entries.length && (
                <div className="files-empty">
                  <FolderOpen size={34} />
                  <h3>{query ? 'Aramaya uygun öğe yok' : 'Klasör boş'}</h3>
                  <p>
                    {query
                      ? 'Başka bir dosya adı arayın.'
                      : cap.streamUpload === false ? 'Yeni dosya veya klasör oluşturabilirsiniz.' : 'Yeni dosya veya klasör oluşturabilir, dosya yükleyebilirsiniz.'}
                  </p>
                </div>
              )}
            </ContextMenuTrigger>
            <ContextMenuContent
              className="files-context-menu"
              finalFocus={false}
            >
              <div className="files-context-title">
                {contextEntry?.name || 'Bu klasör'}
              </div>
              {contextEntry ? (
                <>
                  <ContextMenuItem
                    disabled={busy || loading || !contextEntry.accessible}
                    onClick={() => onOpen(contextEntry)}
                  >
                    <FolderOpen />{' '}
                    {contextEntry.kind === 'directory'
                      ? 'Yeni pencerede aç'
                      : 'Görüntüle'}
                  </ContextMenuItem>
                  {contextEntry.kind === 'directory' && (
                    <ContextMenuItem
                      disabled={busy || loading || !contextEntry.accessible}
                      onClick={() => navigate(contextEntry.path)}
                    >
                      <Folder /> Bu pencerede aç
                    </ContextMenuItem>
                  )}
                  {onVersion && contextEntry.kind === 'directory' && (
                    <ContextMenuItem
                      disabled={busy || loading || !contextEntry.accessible}
                      onClick={() => onVersion(contextEntry.path)}
                    >
                      <FolderGit2 />
                      Sürüm yönetimine ekle
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    disabled={busy || loading || !contextEntry.accessible || cap.streamExport === false}
                    onClick={() => void exportEntry(contextEntry)}
                  >
                    <Download /> Dışa aktar (ZIP)
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={busy || loading || !contextEntry.accessible}
                    onClick={() => buffer(contextEntry, 'copy')}
                  >
                    <Copy /> Kopyala <kbd>Ctrl C</kbd>
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={busy || loading || !contextEntry.mutable}
                    onClick={() => buffer(contextEntry, 'move')}
                  >
                    <Scissors /> Kes <kbd>Ctrl X</kbd>
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!writable || !contextEntry.accessible}
                    onClick={() => prompt('clone', contextEntry)}
                  >
                    <Files /> Klonla <kbd>Ctrl D</kbd>
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={busy || loading || !contextEntry.mutable}
                    onClick={() => prompt('rename', contextEntry)}
                  >
                    <Pencil /> Yeniden adlandır <kbd>F2</kbd>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => copyPath(contextEntry)}>
                    <Copy /> Yolu kopyala
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    disabled={busy || loading || !contextEntry.mutable}
                    onClick={() => {
                      setOperationError('');
                      setRemoving(contextEntry);
                    }}
                  >
                    <Trash2 /> Kaldır <kbd>Delete</kbd>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => setProperties(contextEntry)}>
                    <Info /> Özellikler <kbd>Alt Enter</kbd>
                  </ContextMenuItem>
                </>
              ) : (
                <>
                  <ContextMenuItem
                    disabled={!writable}
                    onClick={() => prompt('create')}
                  >
                    <FilePlus2 /> Yeni dosya
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!writable}
                    onClick={() => prompt('mkdir')}
                  >
                    <FolderPlus /> Yeni klasör
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!writable || cap.streamUpload === false}
                    onClick={() => upload.current?.click()}
                  >
                    <Upload /> Dosya yükle
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!writable || cap.streamUpload === false}
                    onClick={() => folderUpload.current?.click()}
                  >
                    <FolderPlus /> Klasör yükle
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={
                      !writable || !clipboard || clipboard.serverId !== serverId
                    }
                    onClick={() => prompt('paste')}
                  >
                    <ClipboardPaste /> Yapıştır <kbd>Ctrl V</kbd>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => copyPath()}>
                    <Copy /> Klasör yolunu kopyala
                  </ContextMenuItem>
                  {onVersion && (
                    <ContextMenuItem
                      disabled={busy || loading}
                      onClick={() => onVersion(path)}
                    >
                      <FolderGit2 />
                      Bu klasörü sürüm yönetimine ekle
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={busy || loading}
                    onClick={refreshList}
                  >
                    <RefreshCw /> Yenile
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() =>
                      setDisplay(display === 'icons' ? 'details' : 'icons')
                    }
                  >
                    {display === 'icons' ? <List /> : <Grid2X2 />}
                    {display === 'icons' ? 'Ayrıntılı liste' : 'Büyük simgeler'}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() =>
                      setProperties({
                        path,
                        name: path.split('/').at(-1) || 'Sunucu kökü',
                        kind: 'directory',
                      })
                    }
                  >
                    <Info /> Bu klasörün özellikleri
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
          <div className="files-footer">
            <span>
              {loading ? 'Klasör okunuyor…' : `${listing?.total || 0} öğe`}
              {selected ? ` · Seçili: ${selected.name}` : ''}
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selected}
                onClick={() => selected && copyPath(selected)}
              >
                <Copy size={13} />
                Yolu kopyala
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Önceki dosyalar"
                disabled={!offset || loading || busy}
                onClick={() => setOffset(Math.max(0, offset - 200))}
              >
                <ChevronLeft size={15} />
              </Button>
              <span>
                {Math.floor(offset / 200) + 1} /{' '}
                {Math.max(1, Math.ceil((listing?.total || 0) / 200))}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Sonraki dosyalar"
                disabled={
                  offset + 200 >= (listing?.total || 0) || loading || busy
                }
                onClick={() => setOffset(offset + 200)}
              >
                <ChevronRight size={15} />
              </Button>
            </div>
          </div>
        </div>
      </div>
      {properties && (
        <FileProperties
          key={`${serverId}:${properties.path}`}
          item={properties}
          host={host}
          onClose={() => setProperties(null)}
          onMessage={onMessage}
          onPathCopied={onPathCopied}
        />
      )}
      <Dialog
        open={!!operation}
        onOpenChange={(open) => {
          if (!open && !busy) setOperation(null);
        }}
      >
        <DialogContent className="file-name-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {operation?.kind === 'create'
                ? 'Yeni dosya'
                : operation?.kind === 'mkdir'
                  ? 'Yeni klasör'
                  : operation?.kind === 'rename'
                    ? 'Yeniden adlandır'
                    : operation?.kind === 'clone'
                      ? 'Dosya / klasör klonla'
                      : clipboard?.mode === 'move'
                        ? 'Buraya taşı'
                        : 'Buraya kopyala'}
            </DialogTitle>
            <DialogDescription>
              {operation?.kind === 'clone'
                ? `Kaynak: ${operation.entry?.name} · Kopya bu klasöre yeni adla oluşturulur.`
                : operation?.kind === 'paste'
                  ? `Kaynak: ${clipboard?.entry.path} · Hedef: ${path}`
                  : path}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={`${formId}-name`}>
              {operation?.kind === 'mkdir'
                ? 'Klasör adı'
                : 'Dosya / klasör adı'}
            </label>
            <Input
              id={`${formId}-name`}
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={
                operation?.kind === 'create' ? 'notlar.txt' : 'Ad girin'
              }
              required
              maxLength={255}
            />
            {operationError && (
              <p className="form-error" role="alert">
                {operationError}
              </p>
            )}
            <div className="annotation-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOperation(null)}
              >
                Vazgeç
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <RefreshCw className="spin" size={16} />
                ) : (
                  <Save size={16} />
                )}{' '}
                {busy ? 'İşlem yapılıyor…' : 'Uygula'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <AlertDialogContent className="file-name-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Çöp kutusuna taşı</AlertDialogTitle>
            <AlertDialogDescription>
              {host} · {removing?.path}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p>
            Bu öğe bulunduğu yerden kaldırılacak. Çöp kutusundan eski konumuna
            geri yükleyebilirsiniz. Çalışan bir uygulamanın kullandığı dosyayı
            kaldırmak uygulamayı etkileyebilir.
          </p>
          {operationError && (
            <p className="form-error" role="alert">
              {operationError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Vazgeç</AlertDialogCancel>
            <Button
              className="confirm-stop"
              disabled={busy}
              onClick={() => void remove()}
            >
              <Trash2 size={16} />
              {busy ? 'Taşınıyor…' : 'Çöp kutusuna taşı'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
