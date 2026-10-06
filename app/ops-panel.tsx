'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTarget } from './target-context';

type Commit = {
  id: string;
  short: string;
  date: string;
  author: string;
  message: string;
  number?: number;
};
type Environment = {
  port: number | null;
  head: string | null;
  branch: string;
  changes: { status: string; path: string }[];
  total: number;
  latest: Commit | null;
  blocked?: string;
  revision?: string;
  service?: string;
  healthy?: boolean;
  controlAvailable?: boolean;
  protocol?: 'http' | 'https';
  history?: Commit[];
  pendingDevVersions?: number;
  canFastForward?: boolean;
  createdAt?: number;
  lastPromotion?: {
    at: number;
    devHead: string;
    previousUatHead: string;
    backup: string;
  };
};
type Inspection = {
  supported: boolean;
  reason?: string;
  dev?: Environment;
  uat?: Environment | null;
  availablePort?: number;
  profile?: {
    configured: boolean;
    command?: string;
    suggestedCommand?: string | null;
    suggestedEnvironment?: string;
    protocol?: 'http' | 'https';
    healthPath?: string;
    environmentKeys?: string[];
  };
};
type ChangedFile = { path: string; status: string };
type Diff = { text: string; truncated: boolean; note: string };

const date = (value: string) =>
  new Date(value).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export default function OpsPanel({
  id,
  path,
  generation,
  onManage,
  onHistory,
  onBusy,
}: {
  id: string;
  path: string;
  generation: number;
  onManage: (path: string) => void;
  onHistory: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { api, url } = useTarget();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  type Operation = 'promote' | 'devStart' | 'devStop' | 'uatStart' | 'uatStop';
  const [confirm, setConfirm] = useState<Operation | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [commit, setCommit] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [command, setCommand] = useState('');
  const [environment, setEnvironment] = useState('');
  const [protocol, setProtocol] = useState<'http' | 'https'>('http');
  const [healthPath, setHealthPath] = useState('/');
  const commandInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (setupOpen) commandInput.current?.focus();
  }, [setupOpen]);

  const request = useCallback(
    <T,>(body: Record<string, unknown>, signal?: AbortSignal) =>
      api<T>('/ops/action', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    [api],
  );
  const read = useCallback(
    async <T,>(
      operation: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await operation();
        } catch (reason) {
          if (
            signal?.aborted ||
            attempt >= 24 ||
            !(reason as Error).message.includes(
              'Başka bir sürüm işlemi sürüyor',
            )
          )
            throw reason;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError('');
        setInspection(null);
      }
    });
    void read(
      () =>
        api<Inspection>('/ops/projects/' + id, { signal: controller.signal }),
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setInspection(value);
        setCommit(value.uat?.history?.[0]?.id || null);
        setCommand(value.profile?.command || value.profile?.suggestedCommand || '');
        setEnvironment(value.profile?.suggestedEnvironment || '');
        setProtocol(value.profile?.protocol || 'http');
        setHealthPath(value.profile?.healthPath || '/');
        setSetupOpen(false);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, read, id, generation, reload]);

  useEffect(() => {
    if (!inspection?.uat || !commit) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setDetailLoading(true);
        setFiles([]);
        setFile(null);
        setDiff(null);
        setDetailError('');
      }
    });
    void read(
      () =>
        request<{ files: ChangedFile[] }>(
          { action: 'uatFiles', id, commit },
          controller.signal,
        ),
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setFiles(value.files);
        setFile(value.files[0]?.path || null);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [request, read, id, inspection?.uat, commit]);

  useEffect(() => {
    if (!inspection?.uat || !commit || !file) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setDiff(null);
        setDetailLoading(true);
      }
    });
    void read(
      () =>
        request<Diff>(
          { action: 'uatFileDiff', id, commit, file },
          controller.signal,
        ),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setDiff(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [request, read, id, inspection?.uat, commit, file]);

  async function run(action: Operation | 'create') {
    if (!inspection?.dev || busy) return;
    if (action === 'create') {
      if (inspection.dev.blocked || inspection.dev.changes.length || !inspection.dev.head) {
        setError('Önce DEV sürümünü kaydedin; ardından UAT oluşturun.');
        return;
      }
      if (inspection.profile && !command.trim()) {
        setSetupOpen(true);
        setError('Bu uygulamanın başlatma komutu bulunamadı. Aşağıdaki alanı bir kez doldurun.');
        return;
      }
    }
    setConfirm(null);
    setBusy(true);
    setCreating(action === 'create');
    onBusy(true);
    setError('');
    setNotice('');
    try {
      let revision = inspection.dev.revision;
      if (action === 'create' && inspection.profile && (!inspection.profile.configured || setupOpen)) {
        const configured = await request<Inspection>({
          action: 'configure', id, command: command.trim(), environment,
          protocol, healthPath,
        });
        revision = configured.dev?.revision || revision;
      }
      const body = action === 'create'
        ? { action, id, revision }
        : action === 'promote'
          ? {
              action,
              id,
              devHead: inspection.dev.head,
              uatHead: inspection.uat?.head,
            }
          : { action, id };
      const value = await request<Inspection>(body);
      setInspection(value);
      setCommit(value.uat?.history?.[0]?.id || null);
      if (action === 'create') setSetupOpen(false);
      setNotice({
        create: 'UAT ayrı çalışma alanında kuruldu ve sağlık kontrolü geçti.',
        promote: 'DEV sürümü UAT dalına aktarıldı; UAT yeniden başlatıldı ve doğrulandı.',
        devStart: 'DEV başlatıldı ve sağlık kontrolü geçti.',
        devStop: 'DEV kapatıldı. Git sürümleri ve dosyalar korundu.',
        uatStart: 'UAT başlatıldı ve sağlık kontrolü geçti.',
        uatStop: 'UAT kapatıldı. Git sürümleri ve veriler korundu.',
      }[action]);
      setReload((current) => current + 1);
    } catch (reason) {
      setError((reason as Error).message);
      if (action === 'create' && inspection.profile &&
          /(başlat|sağlık kontrolü|çalışma ayarı|komut|ortam değişkeni)/i.test((reason as Error).message))
        setSetupOpen(true);
    } finally {
      setBusy(false);
      setCreating(false);
      onBusy(false);
    }
  }

  const dev = inspection?.dev;
  const uat = inspection?.uat;
  const selected = uat?.history?.find((item) => item.id === commit);
  const canPromote =
    !!uat &&
    !!dev?.head &&
    !!uat.head &&
    dev.head !== uat.head &&
    !dev.changes.length &&
    !uat.changes.length &&
    !dev.blocked &&
    uat.canFastForward &&
    uat.healthy;
  return (
    <div className="ops-panel">
      <div className="ops-panel-heading">
        <div>
          <span className="ops-kicker">OPS · DEV / UAT</span>
          <h2>Uygulama ortamları</h2>
          <p>
            Geliştirmeler DEV’de kalır. Hazır sürümü ayrı porttaki UAT’ye
            aktarın.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> Yenile
        </Button>
      </div>
      {loading && (
        <p className="ops-muted">
          <Loader2 className="spin" size={16} /> Ortam bilgileri yükleniyor…
        </p>
      )}
      {error && (
        <div className="repo-center-error" role="alert">
          {error}
        </div>
      )}
      {notice && <output className="repo-center-notice">{notice}</output>}
      {inspection && !inspection.supported && (
        <div className="ops-unavailable">
          <Server size={24} />
          <strong>Bu proje için UAT profili gerekiyor</strong>
          <p>{inspection.reason}</p>
        </div>
      )}
      {inspection?.supported && dev && (
        <>
          <div className="ops-flow">
            <section className="ops-env-card">
              <div className="ops-env-top">
                <span className="ops-env-icon dev">
                  <GitBranch size={20} />
                </span>
                <span className="ops-env-pill">MEVCUT ORTAM</span>
              </div>
              <h3>DEV</h3>
              {dev.port ? <a href={url(`/apps/${dev.port}/open`)} target="_blank" rel="noopener noreferrer">
                :{dev.port} <ExternalLink size={13} />
              </a> : <span className="ops-placeholder-port">DEV portu eşleştirilmedi</span>}
              <dl>
                <div>
                  <dt>Git dalı</dt>
                  <dd>{dev.branch}</dd>
                </div>
                <div>
                  <dt>Son sürüm</dt>
                  <dd>{dev.latest?.short || '—'}</dd>
                </div>
                <div>
                  <dt>Toplam kayıt</dt>
                  <dd>{dev.total}</dd>
                </div>
                <div>
                  <dt>Bekleyen dosya</dt>
                  <dd>{dev.changes.length}</dd>
                </div>
                {dev.controlAvailable !== false && <div>
                  <dt>Servis</dt>
                  <dd className={dev.healthy ? 'ops-healthy' : 'ops-unhealthy'}>
                    {dev.healthy ? 'Çalışıyor' : dev.service || 'Kontrol gerekli'}
                  </dd>
                </div>}
                {dev.controlAvailable === false && dev.port && <div>
                  <dt>Durum</dt>
                  <dd className={dev.healthy ? 'ops-healthy' : 'ops-unhealthy'}>
                    {dev.healthy ? 'Çalışıyor' : 'DEV şu anda kapalı'}
                  </dd>
                </div>}
              </dl>
              <p className="ops-latest" title={dev.latest?.message}>
                {dev.latest?.message || 'Henüz kayıt yok'}
              </p>
              <div className="ops-env-actions">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onManage(path)}
                >
                  DEV sürümü kaydet
                </Button>
                <Button size="sm" variant="ghost" onClick={onHistory}>
                  Geçmiş
                </Button>
                {dev.controlAvailable !== false && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(dev.healthy ? 'devStop' : 'devStart')}>
                  {dev.healthy ? <Square size={14} /> : <Play size={14} />}
                  {dev.healthy ? 'DEV kapat' : 'DEV aç'}
                </Button>}
              </div>
            </section>
            <div className="ops-flow-arrow">
              <ArrowRight size={20} />
              <span>MERGE</span>
            </div>
            <section className="ops-env-card">
              <div className="ops-env-top">
                <span className="ops-env-icon uat">
                  <Server size={20} />
                </span>
                <span className="ops-env-pill">İSTEĞE BAĞLI</span>
              </div>
              <h3>UAT</h3>
              {uat ? (
                <a
                  href={url(`/apps/${uat.port}/open`)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  :{uat.port} <ExternalLink size={13} />
                </a>
              ) : (
                <span className="ops-placeholder-port">
                  Yeni port: {inspection.availablePort}
                </span>
              )}
              {uat ? (
                <>
                  <dl>
                    <div>
                      <dt>Git dalı</dt>
                      <dd>{uat.branch}</dd>
                    </div>
                    <div>
                      <dt>Son sürüm</dt>
                      <dd>{uat.latest?.short || '—'}</dd>
                    </div>
                    <div>
                      <dt>Toplam kayıt</dt>
                      <dd>{uat.total}</dd>
                    </div>
                    <div>
                      <dt>Servis</dt>
                      <dd
                        className={
                          uat.healthy ? 'ops-healthy' : 'ops-unhealthy'
                        }
                      >
                        {uat.healthy
                          ? 'Çalışıyor'
                          : uat.service || 'Kontrol gerekli'}
                      </dd>
                    </div>
                  </dl>
                  <p className="ops-latest" title={uat.latest?.message}>
                    {uat.latest?.message || 'Henüz kayıt yok'}
                  </p>
                </>
              ) : (
                <p className="ops-setup-copy">
                  {inspection.profile && !inspection.profile.configured && !inspection.profile.suggestedCommand
                    ? 'Bu uygulama için başlatma ayarı bulunamadı. UAT oluştur düğmesi gerekli alanı açar.'
                    : 'Kaydedilmiş DEV sürümünden ayrı bir UAT ortamı ve portu oluşturulur. DEV çalışmaya devam eder.'}
                </p>
              )}
              <div className="ops-env-actions">
                {uat ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(uat.healthy ? 'uatStop' : 'uatStart')}>
                    {uat.healthy ? <Square size={14} /> : <Play size={14} />}
                    {uat.healthy ? 'UAT kapat' : 'UAT aç'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void run('create')}
                  >
                    {creating ? <Loader2 size={15} className="spin" /> : <Rocket size={15} />}
                    {creating ? 'UAT oluşturuluyor…' : 'UAT oluştur'}
                  </Button>
                )}
              </div>
              {!uat && inspection.profile && (
                <>
                  <button type="button" className="ops-advanced-toggle" disabled={busy}
                    aria-expanded={setupOpen} onClick={() => setSetupOpen((open) => !open)}>
                    {setupOpen ? 'Gelişmiş ayarları gizle' : 'Gelişmiş ayarlar (isteğe bağlı)'}
                  </button>
                  {setupOpen && <div className="ops-profile-form">
                    <strong>{inspection.profile.suggestedCommand || inspection.profile.configured
                      ? 'Başlatma ayarları' : 'Bir kez başlatma komutu girin'}</strong>
                    <p>UAT uygulamasını başlatacak komutu yazın. <code>{'{root}'}</code> UAT kodu,
                      <code>{'{state}'}</code> ayrı veri klasörü, <code>{'{port}'}</code> yeni porttur.</p>
                    <label>Başlatma komutu
                      <input ref={commandInput} value={command} onChange={(event) => setCommand(event.target.value)}
                        placeholder="/usr/bin/python3 {root}/app.py" disabled={busy} />
                    </label>
                    <details className="ops-profile-extra">
                      <summary>Diğer ayarlar (isteğe bağlı)</summary>
                      <p>Harici API ve veritabanları için UAT adreslerini burada belirtin.</p>
                      <label>Ortam değişkenleri <small>KEY=VALUE, her satıra bir tane; boş bırakırsanız kayıtlı değerler korunur.</small>
                        <textarea value={environment} onChange={(event) => setEnvironment(event.target.value)}
                          placeholder="DATA_ROOT={state}" rows={2} disabled={busy} />
                      </label>
                      <div className="ops-profile-inline">
                        <label>Protokol
                          <select value={protocol} onChange={(event) => setProtocol(event.target.value as 'http' | 'https')} disabled={busy}>
                            <option value="http">HTTP</option><option value="https">HTTPS</option>
                          </select>
                        </label>
                        <label>Sağlık yolu
                          <input value={healthPath} onChange={(event) => setHealthPath(event.target.value)} disabled={busy} />
                        </label>
                      </div>
                    </details>
                    {inspection.profile.environmentKeys?.length ? <small>Kaydedilmiş değişkenler: {inspection.profile.environmentKeys.join(', ')}</small> : null}
                    <Button size="sm" disabled={busy || !command.trim()} onClick={() => void run('create')}>
                      <Rocket size={15} /> Bu ayarlarla UAT oluştur
                    </Button>
                  </div>}
                </>
              )}
            </section>
          </div>
          {dev.blocked && (
            <div className="repo-center-error" role="alert">
              {dev.blocked}
            </div>
          )}
          {!uat ? (
            <div className="ops-advice">
              <ShieldCheck size={19} />
              <span>
                UAT kurulumu yalnız bu projede sen başlattığında yapılır. Git
                deposu oluşturmak diğer uygulamalara port açmaz.
              </span>
            </div>
          ) : (
            <>
              <div className="ops-promotion">
                <div>
                  <span className="ops-kicker">DAĞITIM</span>
                  <h3>DEV sürümünü UAT’ye aktar</h3>
                  <p>
                    {uat.pendingDevVersions
                      ? uat.pendingDevVersions + ' DEV kaydı UAT’yi bekliyor.'
                      : 'UAT, DEV ile aynı Git sürümünde.'}
                  </p>
                  {!uat.canFastForward && (
                    <small>
                      Geçmişler ayrışmış; otomatik merge çakışma çözümü
                      gerektirir.
                    </small>
                  )}
                </div>
                <Button
                  disabled={!canPromote || busy}
                  onClick={() => setConfirm('promote')}
                >
                  <GitMerge size={16} /> DEV → UAT merge
                </Button>
              </div>
              <div className="ops-history">
                <div className="ops-history-title">
                  <div>
                    <span className="ops-kicker">UAT GIT GEÇMİŞİ</span>
                    <h3>UAT sürümleri</h3>
                  </div>
                  <span>{uat.total} kayıt</span>
                </div>
                <div className="ops-history-grid">
                  <div className="ops-versions">
                    {uat.history?.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-pressed={item.id === commit}
                        onClick={() => setCommit(item.id)}
                      >
                        <strong>Sürüm {item.number}</strong>
                        <span>{item.message}</span>
                        <small>
                          {date(item.date)} · {item.short}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="ops-version-detail">
                    {selected ? (
                      <>
                        <div className="ops-version-meta">
                          <strong>{selected.message}</strong>
                          <small>
                            {selected.author} · {date(selected.date)} ·{' '}
                            {selected.short}
                          </small>
                        </div>
                        <div className="ops-file-list">
                          {files.map((item) => (
                            <button
                              type="button"
                              key={item.path}
                              aria-pressed={item.path === file}
                              onClick={() => setFile(item.path)}
                            >
                              <FileDiff size={14} /> {item.path}
                              <small>{item.status}</small>
                            </button>
                          ))}
                        </div>
                        {detailLoading && (
                          <p className="ops-muted">Fark yükleniyor…</p>
                        )}
                        {detailError && (
                          <div className="repo-center-error" role="alert">
                            {detailError}
                          </div>
                        )}
                        {diff && (
                          <>
                            <pre className="ops-diff">
                              {diff.text || diff.note}
                            </pre>
                            {diff.truncated && (
                              <small className="ops-muted">
                                Büyük fark çıktısı kısaltıldı.
                              </small>
                            )}
                          </>
                        )}
                      </>
                    ) : (
                      <p className="ops-muted">Bir UAT sürümü seçin.</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{promote: 'DEV sürümü UAT’ye aktarılsın mı?',
                devStart: 'DEV açılsın mı?', devStop: 'DEV kapatılsın mı?',
                uatStart: 'UAT açılsın mı?', uatStop: 'UAT kapatılsın mı?'}[confirm || 'promote']}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {{promote: 'DEV’de kaydedilmiş sürüm UAT Git dalına aktarılacak. UAT verisi yedeklenip yalnız UAT servisi yeniden başlatılacak; sağlık kontrolü başarısız olursa önceki UAT sürümüne dönülecek.',
                devStart: 'Mevcut DEV servisi yeniden etkinleştirilip başlatılacak. Sağlık kontrolü başarısız olursa kapatılacak.',
                devStop: 'Mevcut DEV servisi durdurulup otomatik başlatması kapatılacak. Proje dosyaları ve Git geçmişi korunacak.',
                uatStart: 'UAT servisi yeniden etkinleştirilip mevcut UAT sürümünden başlatılacak.',
                uatStop: 'UAT servisi durdurulup otomatik başlatması kapatılacak. UAT dosyaları, verileri ve Git geçmişi korunacak.'}[confirm || 'promote']}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Vazgeç</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                if (confirm) void run(confirm);
              }}
            >
              {{promote: 'Yedekle ve merge et',
                devStart: 'DEV aç', devStop: 'DEV kapat', uatStart: 'UAT aç', uatStop: 'UAT kapat'}[confirm || 'promote']}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
