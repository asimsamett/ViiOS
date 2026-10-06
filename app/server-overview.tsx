'use client';
import { DEMO_MODE } from '@/lib/public-mode';
import { useEffect, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Cpu, HardDrive, MemoryStick, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTarget } from './target-context';
import { storageBytes } from './storage-format';
import { validateOverview, overviewIsFresh } from './overview-state';
import './server-overview.css';

type Rate = { name: string; readBytesPerSecond: number | null; writeBytesPerSecond: number | null };
type Overview = {
  available: boolean; extended: boolean; status: string; hostname: string; host: string; sampledAt: number | null;
  platform: string | null; os: string; kernel: string; addresses: string[]; cpuPercent: number | null; cpuCount: number | null;
  uptimeSeconds: number | null; processCount: number | null; loadAverage: (number | null)[]; cpuTemperatureC: number | null;
  memory: { totalBytes: number | null; usedBytes: number | null; percent: number | null; swapTotalBytes: number | null; swapUsedBytes: number | null };
  disk: { totalBytes: number | null; usedBytes: number | null; availableBytes: number | null; percent: number | null; volumeCount: number | null };
  disks: Rate[]; network: Rate[];
  topProcesses: { pid: number | null; name: string; cpuPercent: number | null; memoryBytes: number | null; state: string }[];
};
const percent = (value?: number | null) => value == null ? '—' : `${value.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}%`;
const bytes = (value?: number | null) => value == null ? '—' : storageBytes(value);
const rate = (value: number | null) => value === null ? 'Ölçülemiyor' : `${bytes(value)}/sn`;
const uptime = (seconds?: number | null) => seconds == null ? '—' : `${Math.floor(seconds / 86400)} gün ${Math.floor(seconds / 3600) % 24} saat ${Math.floor(seconds / 60) % 60} dk`;

function Rates({ title, rows, network = false }: { title: string; rows: Rate[]; network?: boolean }) {
  return <section className="overview-section"><h3>{network ? <Activity size={17}/> : <HardDrive size={17}/>} {title}</h3>
    {rows.length ? <div className="overview-rates">{rows.map((row, index) => <div key={`${row.name}:${index}`}><strong>{row.name}</strong><span><ArrowDownToLine size={14}/>{network ? 'Alınan' : 'Okuma'}: {rate(row.readBytesPerSecond)}</span><span><ArrowUpFromLine size={14}/>{network ? 'Gönderilen' : 'Yazma'}: {rate(row.writeBytesPerSecond)}</span></div>)}</div> : <p className="overview-muted">Bu ölçüm sunucu tarafından sağlanamadı.</p>}
    <p className="overview-muted">{network ? 'Arayüz başına hız. Sanal arayüzlerde aynı trafik birden fazla kez sayılabilir.' : 'Disk aygıtlarının I/O hızları. Süreç I/O değerlerinden bağımsızdır.'}</p>
  </section>;
}

export default function ServerOverview({ visible }: { visible: boolean }) {
  const { api, id } = useTarget();
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | null = null;
    const cancel = () => { clearTimeout(timer); request?.abort(); request = null; };
    async function load() {
      if (!active || document.hidden || request) return;
      const controller = new AbortController(); request = controller; setBusy(true);
      try {
        const result = await api<Overview>('/overview', { signal: controller.signal, cache: 'no-store' });
        if (!active || controller.signal.aborted) return;
        validateOverview(result);
        setData(result); setError('');
      } catch (reason) { if (active && !controller.signal.aborted) setError((reason as Error).message); }
      finally {
        if (request === controller) request = null;
        if (active && !controller.signal.aborted) { setBusy(false); if (!document.hidden) timer = setTimeout(() => void load(), 8000); }
      }
    }
    const wake = () => { cancel(); if (!document.hidden) void load(); };
    void load(); document.addEventListener('visibilitychange', wake);
    return () => { active = false; cancel(); document.removeEventListener('visibilitychange', wake); };
  }, [api, id, visible, revision]);
  const stale = !!error || !overviewIsFresh(data);
  return <div className="server-overview">
    <header className="overview-header"><span className="overview-mark"><Activity size={26}/></span><div><h2>Sunucu Monitörü</h2><p>{data?.hostname || 'Sunucu genel görünümü'} · {data?.host || 'Gerçek zamanlı kaynak ölçümleri'}</p></div><Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={busy ? 'spin' : ''}/>Yenile</Button></header>
    <div className="overview-status"><span className={stale ? 'overview-warning' : 'overview-live'}>{!data && busy ? 'Ölçülüyor…' : stale ? 'Güncel ölçüm bekleniyor' : DEMO_MODE ? 'Temsili demo' : 'Canlı bağlantı'}</span><span>Son ölçüm: {data?.sampledAt ? new Date(data.sampledAt).toLocaleTimeString('tr-TR') : '—'}</span><span>Görünürken otomatik yenilenir</span></div>
    {error && <p className="overview-alert" role="alert">{error} {data ? 'Aşağıda son başarılı ölçüm gösteriliyor.' : ''}</p>}
    {data && !data.extended && <p className="overview-alert">Bu sunucunun agent sürümü genişletilmiş ölçümleri desteklemiyor. Mevcut kaynak bilgileri gösteriliyor; ek ölçümler için agent güncellenmeli.</p>}
    <div className="overview-cards">
      <article><Cpu size={19}/><span>CPU</span><strong>{percent(data?.cpuPercent)}</strong><small>{data?.cpuCount ?? '—'} mantıksal işlemci</small></article>
      <article><MemoryStick size={19}/><span>Bellek</span><strong>{percent(data?.memory.percent)}</strong><small>{bytes(data?.memory.usedBytes)} / {bytes(data?.memory.totalBytes)}</small></article>
      <article><HardDrive size={19}/><span>Depolama · sunucu toplamı</span><strong>{percent(data?.disk.percent)}</strong><small>{bytes(data?.disk.usedBytes)} / {bytes(data?.disk.totalBytes)}</small></article>
      <article><Activity size={19}/><span>Swap / pagefile</span><strong>{bytes(data?.memory.swapUsedBytes)}</strong><small>Toplam {bytes(data?.memory.swapTotalBytes)}</small></article>
    </div>
    <section className="overview-section"><h3>Sistem bilgileri</h3><dl className="overview-details">
      <div><dt>İşletim sistemi</dt><dd>{data?.os || '—'}</dd></div><div><dt>Kernel / sürüm</dt><dd>{data?.kernel || '—'}</dd></div>
      <div><dt>Çalışma süresi</dt><dd>{uptime(data?.uptimeSeconds)}</dd></div><div><dt>Süreç sayısı</dt><dd>{data?.processCount ?? '—'}</dd></div>
      <div><dt>Kullanılabilir disk alanı</dt><dd>{bytes(data?.disk.availableBytes)}</dd></div><div><dt>CPU sıcaklığı</dt><dd>{data?.cpuTemperatureC == null ? 'Sensör verisi yok' : `${data.cpuTemperatureC} °C`}</dd></div>
      <div><dt>Load average · 1 / 5 / 15 dk</dt><dd>{data?.platform === 'windows' ? 'Windows için geçerli değil' : data?.loadAverage.length ? data.loadAverage.map(value => value?.toFixed(2) ?? '—').join(' / ') : '—'}</dd></div>
      <div><dt>IP adresleri</dt><dd>{data?.addresses.join(' · ') || '—'}</dd></div>
    </dl></section>
    <div className="overview-columns"><Rates title="Disk I/O" rows={data?.disks || []}/><Rates title="Ağ trafiği" rows={data?.network || []} network/></div>
    <section className="overview-section"><h3>En çok kaynak kullanan süreçler</h3><p className="overview-muted">CPU kullanımına göre ilk 10 süreç. Yüzdeler toplam işlemci kapasitesine göre hesaplanır.</p><div className="overview-table"><table><thead><tr><th>PID</th><th>Süreç</th><th>CPU</th><th>Bellek</th></tr></thead><tbody>{data?.topProcesses.map(row => <tr key={row.pid}><td>{row.pid}</td><td>{row.name}</td><td>{percent(row.cpuPercent)}</td><td>{bytes(row.memoryBytes)}</td></tr>)}</tbody></table>{!data?.topProcesses.length && <p className="overview-muted">Süreç ölçümü henüz yok.</p>}</div></section>
  </div>;
}
