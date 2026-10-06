'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Check,
  ChevronRight,
  FileDiff,
  FolderGit2,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTarget } from './target-context';
import type { App } from './types';

export type VersionCapabilities = {
  available: boolean;
  reason?: string;
  root: string;
  demoRoot?: string;
  roots?: string[];
  projectRoots?: string[];
  gitVersion: string;
  automatic: boolean;
  ignore: string[];
};
type Project = { id: string; name: string; path: string; existing: boolean };
type Commit = {
  id: string;
  short: string;
  date: string;
  message: string;
  refs: string;
};
type Snapshot = {
  path: string;
  name: string;
  head: string | null;
  branch: string;
  changes: { status: string; path: string }[];
  history: Commit[];
  blocked: string;
  revision: string;
  remoteNames: string[];
  ignoredCount: number;
};
type Result = {
  project: Project;
  state: Snapshot;
  backup?: string;
  checkpoint?: string;
  unchanged?: boolean;
};
type Inspection = {
  path: string;
  selectedPath: string;
  name: string;
  exists: boolean;
  revision: string;
  ignore: string[];
  registered: string | null;
  branch?: string;
  needsAccess?: boolean;
  accessRevision?: string;
};
type Diff = { text: string; truncated: boolean; note: string };
const date = (value: string) =>
  new Date(value).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export default function VersionPanel({
  initialPath,
  capability,
  apps,
  onClose,
  onBusy,
  onChanged,
  onFolder,
  onOpenOps,
}: {
  initialPath?: string;
  capability: VersionCapabilities;
  apps: App[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  onFolder: (path: string) => void;
  onOpenOps: (id: string) => void;
}) {
  const { api, id: serverId } = useTarget();
  const [projects, setProjects] = useState<Project[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [path, setPath] = useState(initialPath || '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [diff, setDiff] = useState<Diff | null>(null);
  const [restoring, setRestoring] = useState<Commit | null>(null);
  const [setupUat, setSetupUat] = useState(false);
  const running = useRef(false);
  const request = useCallback(
    <T,>(body: Record<string, unknown>) =>
      api<T>('/versions/action', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    [api],
  );
  const list = useCallback(async () => {
    const data = await api<{ projects: Project[] }>('/versions/projects');
    setProjects(data.projects);
  }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ projects: Project[] }>('/versions/projects', {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setProjects(data.projects);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [api]);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  function inspect(selectedPath = path) {
    void run(async () => {
      setResult(null);
      setInspection(null);
      setDiff(null);
      setRestoring(null);
      const value = await request<Inspection>({
        action: 'inspect',
        path: selectedPath,
      });
      setInspection(value);
      if (value.registered) {
        setResult(
          await request<Result>({ action: 'status', id: value.registered }),
        );
        setInspection(null);
      }
    });
  }
  function prepareAccess() {
    if (!inspection?.needsAccess) return;
    void run(async () => {
      const value = await request<Inspection>({
        action: 'prepare',
        path: inspection.path,
        revision: inspection.accessRevision,
      });
      setInspection(value);
      setPath(value.path);
      setNotice('Erişim hazırlandı. Önceki izinler yedeklendi.');
      if (value.registered) {
        setResult(
          await request<Result>({ action: 'status', id: value.registered }),
        );
        setInspection(null);
      }
    });
  }
  function select(project: Project) {
    void run(async () => {
      setResult(await request<Result>({ action: 'status', id: project.id }));
      setInspection(null);
      setDiff(null);
      setRestoring(null);
      setMessage('');
      setPath(project.path);
    });
  }
  function register() {
    if (!inspection) return;
    void run(async () => {
      const value = await request<Result>({
        action: 'register',
        path: inspection.path,
        revision: inspection.revision,
      });
      setResult(value);
      setInspection(null);
      await list();
      onChanged();
      if (setupUat) onOpenOps(value.project.id);
      else setNotice(inspection.exists ? 'Mevcut Git geçmişi bağlandı.' : 'İlk sürüm kaydedildi.');
    });
  }
  function refresh() {
    void run(async () => {
      await list();
      setDiff(null);
      setRestoring(null);
      if (result) {
        const value = await request<Result>({
          action: 'status',
          id: result.project.id,
        });
        setResult(value);
        setPath(value.project.path);
      }
    });
  }
  function save() {
    if (!result) return;
    void run(async () => {
      const value = await request<Result>({
        action: 'commit',
        id: result.project.id,
        revision: result.state.revision,
        message,
      });
      setResult(value);
      setMessage('');
      setDiff(null);
      onChanged();
      setNotice(
        value.unchanged ? 'Yeni değişiklik bulunmuyor.' : 'Sürüm kaydedildi.',
      );
    });
  }
  function restore() {
    if (!result || !restoring) return;
    void run(async () => {
      const value = await request<Result>({
        action: 'restore',
        id: result.project.id,
        revision: result.state.revision,
        commit: restoring.id,
      });
      setResult(value);
      setRestoring(null);
      setDiff(null);
      onChanged();
      setNotice(
        value.checkpoint
          ? 'Önce çalışma kaydı alındı. Seçilen sürüm yeni kayıt olarak geri getirildi.'
          : 'Seçilen sürüm yeni kayıt olarak geri getirildi.',
      );
    });
  }
  function showDiff(commit?: string) {
    if (!result) return;
    void run(async () =>
      setDiff(
        await request<Diff>({
          action: 'diff',
          id: result.project.id,
          ...(commit ? { commit } : {}),
        }),
      ),
    );
  }
  const current = result?.state;
  const appChoices = new Map<string, string[]>();
  for (const app of apps) {
    const directory = app.directory?.replace(/\/$/, '');
    if (
      !directory ||
      !(
        capability.roots?.some((root) => directory.startsWith(root + '/')) ||
        capability.projectRoots?.some(
          (root) => directory === root || directory.startsWith(root + '/'),
        )
      ) ||
      [
        '/opt/viios',
        '/var/lib/viios',
        '/opt/containerd',
        '/usr',
      ].some((root) => directory === root || directory.startsWith(root + '/'))
    )
      continue;
    appChoices.set(directory, [
      ...(appChoices.get(directory) || []),
      `${app.name} · ${app.port}`,
    ]);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running.current) onClose();
      }}
    >
      <DialogContent className="version-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="version-title">
            <FolderGit2 size={22} /> Projeler ve Sürümler{' '}
            <span className="version-trial">Git</span>
          </DialogTitle>
          <DialogDescription>
            Sunucu · {capability.gitVersion} · Otomatik kayıt kapalı
          </DialogDescription>
        </DialogHeader>
        <div className="version-banner">
          <Archive size={18} />
          <span>
            Uygulamanızı seçin. Her projenin geçmişi ayrı tutulur.
            <small>
              İşlem öncesinde Git geçmişi ve sürüm kapsamındaki dosyalar
              yedeklenir.
            </small>
          </span>
        </div>
        <div className="version-layout">
          <aside className="version-sidebar">
            <div className="version-section-label">
              PROJELER <span>{projects.length}</span>
            </div>
            {projects.length === 0 && (
              <p className="version-muted">
                Henüz proje eklenmedi. Listeden bir uygulama seçerek başlayın.
              </p>
            )}
            {projects.map((project) => (
              <button
                key={project.id}
                disabled={busy}
                className={
                  'version-project ' +
                  (project.id === result?.project.id ? 'selected' : '')
                }
                onClick={() => select(project)}
              >
                <FolderGit2 size={18} />
                <span>
                  {project.name}
                  <small>
                    {project.existing ? 'Mevcut geçmiş' : 'Yeni depo'}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                onFolder(result?.project.path || capability.root);
                onClose();
              }}
            >
              Proje klasörünü aç
            </Button>
            <p className="version-muted">
              Projeler tek tek eklenir. Kayıt almak için Sürüm kaydet düğmesini
              kullanın.
            </p>
          </aside>
          <main className="version-main">
            <form
              className="version-connect"
              onSubmit={(e) => {
                e.preventDefault();
                inspect();
              }}
            >
              <label htmlFor={'version-app-' + serverId}>
                Uygulamadan proje seç
              </label>
              <select
                id={'version-app-' + serverId}
                aria-label="Uygulamadan proje seç"
                disabled={busy}
                value={appChoices.has(path) ? path : ''}
                onChange={(event) => {
                  const selectedPath = event.target.value;
                  if (!selectedPath) return;
                  setPath(selectedPath);
                  inspect(selectedPath);
                }}
              >
                <option value="">Bir uygulama seçin…</option>
                {[...appChoices].map(([directory, names]) => (
                  <option key={directory} value={directory}>
                    {names.join(' / ')}
                  </option>
                ))}
              </select>
              <label htmlFor={'version-path-' + serverId}>Proje klasörü</label>
              <div>
                <Input
                  id={'version-path-' + serverId}
                  value={path}
                  placeholder="Veya sunucudaki proje klasörünün yolunu yazın"
                  disabled={busy}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setInspection(null);
                    setResult(null);
                    setDiff(null);
                    setRestoring(null);
                  }}
                />
                <Button type="submit" disabled={busy || !path}>
                  İncele
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={refresh}
                  aria-label="Sürümleri yenile"
                >
                  <RefreshCw size={16} />
                </Button>
              </div>
            </form>
            {error && (
              <div className="version-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <output className="version-notice">
                <Check size={16} />
                {notice}
              </output>
            )}
            {busy && (
              <output className="version-progress">
                <Loader2 size={16} className="spin" /> İşlem sürüyor…
              </output>
            )}
            {inspection && (
              <section className="version-onboarding">
                <FolderGit2 size={34} />
                <h3>{inspection.name}</h3>
                <p>
                  {inspection.exists
                    ? 'Mevcut Git deposu bulundu. Geçmiş kayıtlar ve seçili dal korunarak bağlanacak.'
                    : 'Git geçmişi bulunamadı. İlk sürüm bu klasörde oluşturulacak.'}
                </p>
                <code>{inspection.path}</code>
                <p className="version-muted">
                  Kaynak dosyaları sürümlenir. Ortam sırları, bağımlılıklar,
                  loglar ve veritabanı dosyaları varsayılan olarak dışlanır.
                  Önceden izlenen dosyalar kendiliğinden takipten çıkarılmaz.
                </p>
                {inspection.ignore.length > 0 && (
                  <details className="version-exclusions">
                    <summary>Bu proje için dışlama kurallarını göster</summary>
                    <pre>
                      {inspection.ignore
                        .filter((rule) => rule && !rule.startsWith('#'))
                        .join('\n')}
                    </pre>
                  </details>
                )}
                {inspection.path !== inspection.selectedPath && (
                  <p>
                    Seçtiğiniz alt klasör bu depoya ait. İşlem yukarıdaki proje
                    kökünü kapsar.
                  </p>
                )}
                <label className="version-uat-option">
                  <input type="checkbox" aria-label="UAT kurulumuna geç" checked={setupUat} disabled={busy}
                    onChange={(event) => setSetupUat(event.target.checked)} />
                  <span><strong>UAT kurulumuna geç</strong>
                    <small>İsteğe bağlı. Git kaydından sonra UAT ekranı açılır; oradan UAT oluşturabilirsiniz.</small>
                  </span>
                </label>
                {inspection.needsAccess ? (
                  <>
                    <p>
                      Bu projeye sürüm kaydı alabilmek için yönetim servisine
                      proje klasöründe okuma ve yazma erişimi verilecek. Dosya
                      sahiplikleri korunur; önceki izinler yedeklenir.
                    </p>
                    <Button disabled={busy} onClick={prepareAccess}>
                      Erişimi hazırla ve incele
                    </Button>
                  </>
                ) : (
                  <>
                    {!inspection.exists && (
                      <p className="version-muted">
                        Ortam sırları, anahtarlar, bağımlılıklar ve derleme
                        çıktıları ilk kayıt dışında tutulur.
                      </p>
                    )}
                    <Button disabled={busy} onClick={register}>
                      {inspection.exists
                        ? 'Mevcut geçmişi bağla'
                        : 'İlk sürümü oluştur'}
                    </Button>
                  </>
                )}
              </section>
            )}
            {current && (
              <>
                <div className="version-project-heading">
                  <div>
                    <h3>{current.name}</h3>
                    <code>{current.path}</code>
                  </div>
                  <span>
                    <GitBranch size={15} />
                    {current.branch}
                  </span>
                </div>
                <div className="version-stats">
                  <span>
                    <strong>{current.changes.length}</strong> değişen dosya
                  </span>
                  <span>
                    <strong>
                      {current.history.length}
                      {current.history.length === 50 ? '+' : ''}
                    </strong>{' '}
                    kayıt
                  </span>
                  <span>{current.ignoredCount} dışlanan öğe</span>
                </div>
                {current.blocked && (
                  <div role="alert" className="version-error">
                    {current.blocked}
                  </div>
                )}
                <div
                  className="version-tabs"
                  role="tablist"
                  aria-label="Sürüm görünümü"
                >
                  <button
                    role="tab"
                    aria-selected={tab === 'changes'}
                    onClick={() => {
                      setTab('changes');
                      setDiff(null);
                    }}
                  >
                    <FileDiff size={16} />
                    Değişiklikler
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'history'}
                    onClick={() => {
                      setTab('history');
                      setDiff(null);
                    }}
                  >
                    <History size={16} />
                    Geçmiş
                  </button>
                </div>
                {tab === 'changes' ? (
                  <section className="version-tab-content">
                    {current.changes.length ? (
                      <>
                        <ul className="version-files">
                          {current.changes.map((file) => (
                            <li key={file.path}>
                              <code>
                                {file.status.trim() === '??'
                                  ? 'YENİ'
                                  : file.status.trim()}
                              </code>
                              <span>{file.path}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="version-muted">
                          Sürüm kaydı, bu listedeki tüm değişiklikleri kapsar.
                        </p>
                      </>
                    ) : (
                      <div className="version-clean">
                        <Check size={26} />
                        <span>Tüm değişiklikler kayıtlı.</span>
                      </div>
                    )}
                    <Input
                      aria-label="Sürüm açıklaması"
                      placeholder="Kısa bir açıklama yazın (isteğe bağlı)"
                      maxLength={300}
                      disabled={busy}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                    <div className="version-buttons">
                      <Button
                        disabled={
                          busy || !!current.blocked || !current.changes.length
                        }
                        onClick={save}
                      >
                        <Save size={16} />
                        Sürüm kaydet
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || !!current.blocked}
                        onClick={() => showDiff()}
                      >
                        <FileDiff size={16} />
                        Değişiklikleri gör
                      </Button>
                    </div>
                  </section>
                ) : (
                  <section className="version-tab-content">
                    <p className="version-muted">
                      Son 50 kayıt · Geri getirme eski kayıtları silmez.
                    </p>
                    <ol className="version-history">
                      {current.history.map((entry) => (
                        <li key={entry.id}>
                          <div className="version-history-dot" />
                          <div className="version-history-entry">
                            <strong>{entry.message}</strong>
                            <small>
                              <code>{entry.short}</code> · {date(entry.date)}
                              {entry.refs && <span> · {entry.refs}</span>}
                            </small>
                            <div className="version-buttons">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || !!current.blocked}
                                onClick={() => showDiff(entry.id)}
                              >
                                Değişiklikler
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  busy ||
                                  !!current.blocked ||
                                  (entry.id === current.head &&
                                    !current.changes.length)
                                }
                                onClick={() => {
                                  setRestoring(entry);
                                  setDiff(null);
                                }}
                              >
                                <RotateCcw size={14} />
                                Bu sürümü geri getir
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
                {restoring && (
                  <div className="version-confirm">
                    <h4>{restoring.short} sürümü geri getirilecek</h4>
                    <p>
                      Sürüm kapsamındaki dosyalar ve Git geçmişi önce
                      yedeklenecek. Kaydedilmemiş değişiklikler ayrıca çalışma
                      kaydı olacak. Seçilen içerik yeni bir sürüm olarak
                      uygulanacak. Proje dosyaları değişeceği için çalışan
                      uygulama etkilenebilir; uygulama otomatik yeniden
                      başlatılmaz.
                    </p>
                    <div className="version-buttons">
                      <Button disabled={busy} onClick={restore}>
                        Yedekle ve geri getir
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => setRestoring(null)}
                      >
                        Vazgeç
                      </Button>
                    </div>
                  </div>
                )}
                {result?.backup && (
                  <p className="version-receipt">
                    <Archive size={14} />
                    İşlem öncesi yedek: <code>{result.backup}</code>
                  </p>
                )}
              </>
            )}
            {diff && (
              <section className="version-diff">
                <div>
                  <strong>Dosya farkları</strong>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDiff(null)}
                  >
                    Kapat
                  </Button>
                </div>
                <pre>{diff.text || 'İzlenen dosyalarda metin farkı yok.'}</pre>
                <p className="version-muted">
                  {diff.note}
                  {diff.truncated ? ' Büyük çıktı kısaltıldı.' : ''}
                </p>
              </section>
            )}
            {!inspection && !current && (
              <div className="version-welcome">
                <FolderGit2 size={44} />
                <h3>Projenizin geçmişi burada.</h3>
                <p>
                  Klasörü inceleyin. Yeni bir depo başlatın veya mevcut
                  geçmişten devam edin.
                </p>
                <p className="version-muted">
                  Yukarıdaki uygulama listesi sunucuda bulunan projelerden
                  oluşur. Listede olmayan bir proje için klasör yolunu
                  yazabilirsiniz.
                </p>
              </div>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
