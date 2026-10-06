'use client';
import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownWideNarrow,
  Cpu,
  HardDrive,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTarget } from './target-context';
import { storageBytes } from './storage-format';
import type { App } from './types';

type ResourceApp = {
  id: string;
  ports: number[];
  listenerPids: number[];
  pids: number[];
  processNames: string[];
  transports: string[];
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryPercent: number | null;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  scope: 'process-tree' | 'proxy' | 'unavailable';
};
type ResourceData = {
  available: boolean;
  reason?: string;
  host: string;
  hostname: string;
  sampledAt: number;
  sampleSeconds: number;
  portCount: number;
  applications: ResourceApp[];
  system: {
    cpuPercent: number | null;
    cpuCount: number;
    memory: {
      totalBytes: number;
      usedBytes: number | null;
      percent: number | null;
      swapTotalBytes: number;
      swapUsedBytes: number;
    };
    disk: {
      mount: string | null;
      scope?: 'server';
      available?: boolean;
      reason?: string;
      volumeCount?: number;
      totalBytes: number | null;
      usedBytes: number | null;
      percent: number | null;
      availableBytes?: number | null;
      reservedBytes?: number | null;
    };
    uptimeSeconds: number;
    loadAverage: number[];
    processCount: number;
  };
};
type Point = { at: number; cpu: number | null; memory: number | null };
const percent = (value: number | null | undefined) =>
  value == null
    ? '—'
    : `${value.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const bytes = storageBytes;
const rate = (value: number | null) =>
  value == null ? '—' : `${bytes(value)}/sn`;
function Trend({
  points,
  field,
  label,
}: {
  points: Point[];
  field: 'cpu' | 'memory';
  label: string;
}) {
  const line = points
    .map((p, index) => {
      if (p[field] === null) return '';
      const segment = `${index === 0 || points[index - 1][field] === null ? 'M' : 'L'}${((index / Math.max(29, points.length - 1)) * 290 + 5).toFixed(1)},${(62 - Math.min(100, p[field]!) * 0.55).toFixed(1)}`;
      return segment;
    })
    .join(' ');
  return (
    <svg
      className={`resource-trend ${field}`}
      viewBox="0 0 300 70"
      aria-label={`${label} son ölçümler, yüzde 0 ile 100 arası`}
    >
      <path
        className="trend-grid"
        d="M0 7H300M0 35H300M0 62H300M75 0V70M150 0V70M225 0V70"
      />
      <path className="trend-line" d={line} />
      {points.length === 1 && points[0][field] !== null && (
        <circle cx="5" cy={62 - points[0][field]! * 0.55} r="2" />
      )}
    </svg>
  );
}
export default function TaskManager({
  host,
  apps,
  visible,
  onInspect,
  onStorage,
}: {
  host: string;
  apps: App[];
  visible: boolean;
  onInspect: (app: App) => void;
  onStorage?: () => void;
}) {
  const { api } = useTarget();
  const [data, setData] = useState<ResourceData | null>(null),
    [error, setError] = useState('');
  const [paused, setPaused] = useState(false),
    [reload, setReload] = useState(0),
    [query, setQuery] = useState('');
  const [sort, setSort] = useState<'cpu' | 'memory' | 'port'>('cpu'),
    [points, setPoints] = useState<Point[]>([]);
  const [fetching, setFetching] = useState(false);
  useEffect(() => {
    if (!visible || paused) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>,
      running = false;
    async function load() {
      if (running || controller.signal.aborted) return;
      if (document.visibilityState === 'hidden') return;
      running = true;
      setFetching(true);
      let nextDelay = 250;
      try {
        const next = await api<ResourceData>('/resources', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setData(next);
        setError('');
        if (next.available)
          setPoints((current) =>
            current.at(-1)?.at === next.sampledAt
              ? current
              : [
                  ...current,
                  {
                    at: next.sampledAt,
                    cpu: next.system.cpuPercent,
                    memory: next.system.memory.percent,
                  },
                ].slice(-30),
          );
      } catch (e) {
        nextDelay = 3000;
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          setFetching(false);
          if (document.visibilityState === 'visible')
            timer = setTimeout(() => void load(), nextDelay);
        }
      }
    }
    const wake = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void load();
      }
    };
    timer = setTimeout(() => void load(), 0);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', wake);
    };
  }, [api, visible, paused, reload]);
  const rows = (data?.applications || [])
    .map((row) => {
      const matched = apps.filter(
        (app) =>
          row.ports.includes(app.port) &&
          app.pid !== null &&
          row.listenerPids.includes(app.pid),
      );
      const names = [...new Set(matched.map((app) => app.name))];
      return {
        ...row,
        label: names.length
          ? names.join(' · ')
          : row.processNames.join(', ') || `Port ${row.ports.join(', ')}`,
        app: matched[0],
      };
    })
    .filter((row) =>
      `${row.label} ${row.ports.join(' ')} ${row.pids.join(' ')} ${row.processNames.join(' ')}`
        .toLocaleLowerCase('tr-TR')
        .includes(query.toLocaleLowerCase('tr-TR')),
    )
    .sort((a, b) =>
      sort === 'port'
        ? a.ports[0] - b.ports[0]
        : sort === 'cpu'
          ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
          : (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1),
    );
  const system = data?.available ? data.system : undefined;
  const disk = system?.disk.scope === 'server' ? system.disk : undefined;
  return (
    <section className="task-manager" aria-label={`${host} görev yöneticisi`}>
      <header className="resource-header">
        <div>
          <span className="resource-heading-icon">
            <Activity size={21} />
          </span>
          <div>
            <h2>Görev Yöneticisi</h2>
            <p>{host} · Çalışan uygulamalar</p>
          </div>
        </div>
        <div>
          <span
            className={`resource-live ${paused || error ? 'paused' : ''}`}
            title="Kaynak ölçümleri yaklaşık saniyede bir güncellenir"
          >
            <i />
            {paused ? 'Duraklatıldı' : error ? 'Son ölçüm' : 'Anlık'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              paused ? 'Canlı ölçümü sürdür' : 'Canlı ölçümü duraklat'
            }
            title={paused ? 'Sürdür' : 'Duraklat'}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={fetching && !paused}
            aria-label="Kaynak ölçümünü yenile"
            title="Yenile"
            onClick={() => {
              setPaused(false);
              setReload((n) => n + 1);
            }}
          >
            <RefreshCw
              size={16}
              className={fetching && !paused ? 'spin' : ''}
            />
          </Button>
        </div>
      </header>
      {error && (
        <div className="resource-error" role="alert">
          {error}
          {data?.sampledAt ? ' Son başarılı ölçüm gösteriliyor.' : ''}
        </div>
      )}
      {data && !data.available ? (
        <div className="files-empty">
          <Activity size={38} />
          <h3>Bu sunucu için kaynak ölçümü açık değil</h3>
          <p>{data.reason}</p>
        </div>
      ) : (
        <>
          <div className="resource-summary">
            <article className="resource-card cpu">
              <div>
                <span>
                  <Cpu size={16} />
                  CPU
                </span>
                <strong>{percent(system?.cpuPercent)}</strong>
              </div>
              <Trend points={points} field="cpu" label="Sunucu CPU" />
              <small>
                {system?.cpuCount ?? '—'} mantıksal çekirdek · Sunucu toplamı
              </small>
            </article>
            <article className="resource-card memory">
              <div>
                <span>
                  <MemoryStick size={16} />
                  Bellek
                </span>
                <strong>{percent(system?.memory.percent)}</strong>
              </div>
              <Trend points={points} field="memory" label="Sunucu RAM" />
              <small>
                {bytes(system?.memory.usedBytes)} /{' '}
                {bytes(system?.memory.totalBytes)}
              </small>
            </article>
            <article className="resource-card disk">
              <div>
                <span>
                  <HardDrive size={16} />
                  Disk · Sunucu
                </span>
                <strong>{percent(disk?.percent)}</strong>
              </div>
              <div className="resource-capacity">
                {disk?.percent != null && <span style={{ width: `${Math.max(0, Math.min(100, disk.percent))}%` }} />}
              </div>
              <small>
                {bytes(disk?.usedBytes)} /{' '}
                {bytes(disk?.totalBytes)}
                <br />
                {disk?.volumeCount == null ? 'Ölçüm bekleniyor' : `${disk.volumeCount} disk bölümü · Sunucu toplamı`}
                <br />
                Kullanılabilir: {bytes(disk?.availableBytes)}
                {disk?.available === false && <><br />{disk.reason || 'Disk ölçümü alınamadı'}</>}
              </small>
              {onStorage && <Button variant="ghost" className="resource-storage-link" onClick={onStorage}><HardDrive size={12}/>Depolamayı aç</Button>}
            </article>
            <article className="resource-card running">
              <div>
                <span>
                  <Activity size={16} />
                  Ayakta
                </span>
                <strong>{data?.applications.length ?? '—'}</strong>
              </div>
              <p>{data?.portCount ?? '—'} açık port</p>
              <small>
                {system?.processCount ?? '—'} sistem süreci
                <br />
                Ortak süreçler birlikte gösterilir
              </small>
            </article>
          </div>
          <div className="resource-tools">
            <div className="search-field">
              <Search size={16} />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Uygulama, port veya PID ara…"
                aria-label="Çalışan uygulamalar içinde ara"
              />
            </div>
            <label>
              <ArrowDownWideNarrow size={16} />
              <select
                aria-label="Kaynak kullanımına göre sırala"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="cpu">CPU kullanımı</option>
                <option value="memory">RAM kullanımı</option>
                <option value="port">Port numarası</option>
              </select>
            </label>
          </div>
          <div className="resource-table-wrap">
            <table className="resource-table">
              <thead>
                <tr>
                  <th>Uygulama / süreç</th>
                  <th>Portlar</th>
                  <th>
                    <button
                      aria-label="CPU kullanımına göre sırala"
                      onClick={() => setSort('cpu')}
                    >
                      CPU {sort === 'cpu' ? '↓' : ''}
                    </button>
                  </th>
                  <th>
                    <button
                      aria-label="RAM kullanımına göre sırala"
                      onClick={() => setSort('memory')}
                    >
                      RAM {sort === 'memory' ? '↓' : ''}
                    </button>
                  </th>
                  <th>Disk oku / yaz</th>
                  <th>
                    <span className="sr-only">İşlemler</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td aria-label={row.label}>
                      <div className="resource-app-name">
                        <span>
                          <Activity size={17} />
                        </span>
                        <div>
                          <strong title={row.label}>{row.label}</strong>
                          <small title={row.pids.join(', ')}>
                            {row.scope === 'proxy'
                              ? 'Port aracısı · Container ölçümü yok'
                              : row.scope === 'unavailable'
                                ? 'Süreç ölçümü alınamadı'
                                : `PID ${row.listenerPids.slice(0, 3).join(', ')}${row.listenerPids.length > 3 ? '…' : ''} · ${row.pids.length} süreç`}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="resource-ports">
                        {row.ports.join(', ')}
                      </span>
                      <small>{row.transports.join(' / ').toUpperCase()}</small>
                    </td>
                    <td className="resource-number">
                      <div
                        className="resource-usage-bar"
                        style={{ width: `${row.cpuPercent || 0}%` }}
                      />
                      <strong>{percent(row.cpuPercent)}</strong>
                    </td>
                    <td className="resource-number">
                      <div
                        className="resource-usage-bar memory"
                        style={{
                          width: `${Math.min(100, row.memoryPercent || 0)}%`,
                        }}
                      />
                      <strong>{bytes(row.memoryBytes)}</strong>
                      <small>{percent(row.memoryPercent)}</small>
                    </td>
                    <td className="resource-io">
                      <span>{rate(row.readBytesPerSecond)}</span>
                      <small>{rate(row.writeBytesPerSecond)}</small>
                    </td>
                    <td>
                      {row.app && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Uygulama ayrıntıları ve yönetim"
                          onClick={() => onInspect(row.app!)}
                        >
                          <Settings2 size={15} />
                          Yönet
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="files-empty">
                {!data && !error ? (
                  <>
                    <RefreshCw className="spin" />
                    <p>Sunucu kaynakları ölçülüyor…</p>
                  </>
                ) : (
                  <p>
                    {query
                      ? 'Bu aramaya uygun çalışan uygulama yok.'
                      : error
                        ? 'Ölçüm alınamadı. Yenile ile tekrar deneyebilirsiniz.'
                        : 'Dinleyen uygulama bulunamadı.'}
                  </p>
                )}
              </div>
            )}
          </div>
          <footer className="resource-footer">
            <span>{rows.length} uygulama grubu</span>
            <span>
              {data?.sampledAt
                ? `Ölçüm: ${new Date(data.sampledAt).toLocaleTimeString('tr-TR')}`
                : 'Ölçüm bekleniyor'}
              {system
                ? ` · Çalışma süresi ${Math.floor(system.uptimeSeconds / 86400)} gün ${Math.floor(system.uptimeSeconds / 3600) % 24} saat`
                : ''}
            </span>
          </footer>
          <p className="resource-note">
            CPU yüzdesi tüm çekirdeklerin toplam kapasitesine göredir. RAM,
            dinleyen süreçler ve onlara bağlı alt süreçlerin RSS toplamıdır;
            paylaşılan bellek içerebilir. “—” ölçüm alınamadığını belirtir.
            Container içi tüketim port aracısından ölçülmez.
          </p>
        </>
      )}
    </section>
  );
}
