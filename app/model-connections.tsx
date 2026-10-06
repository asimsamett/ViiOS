'use client';
import { useState } from 'react';
import { BrainCircuit, Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from './api';
import type { App, ModelConnection } from './types';

export function modelSearchText(app: App) {
  return (app.modelConnections || []).map(row => `${row.model || ''} ${row.endpoint}`).join(' ');
}
function collect(apps: App[]) {
  const rows = new Map<string, ModelConnection & { ports: number[] }>();
  for (const app of apps) for (const row of app.modelConnections || []) {
    const key = `${row.endpoint}\0${row.model}\0${row.role}`;
    const previous = rows.get(key);
    if (previous) {
      if (!previous.ports.includes(app.port)) previous.ports.push(app.port);
      for (const evidence of row.evidence) if (!previous.evidence.some(item => JSON.stringify(item) === JSON.stringify(evidence))) previous.evidence.push(evidence);
      if (row.scope === 'process') previous.scope = 'process';
    } else rows.set(key, { ...row, evidence: [...row.evidence], ports: [app.port] });
  }
  return [...rows.values()];
}
export function ModelSummary({ apps }: { apps: App[] }) {
  const rows = collect(apps);
  if (!rows.length) return null;
  const names = [...new Set(rows.map(row => row.model || 'Model adı belirtilmemiş'))];
  return <span className="model-summary" title={rows.map(row => `${row.model || 'Model'} · ${row.endpoint}`).join('\n')}><BrainCircuit size={14} /><span>{names.slice(0, 2).join(' · ')}{names.length > 2 ? ` +${names.length - 2}` : ''}</span></span>;
}
export default function ModelConnections({ apps }: { apps: App[] }) {
  const [copied, setCopied] = useState(''), [error, setError] = useState('');
  const rows = collect(apps);
  const checks = apps.flatMap(app => app.modelDiscovery?.checkedAt ? [app.modelDiscovery.checkedAt] : []).sort();
  const partial = apps.some(app => app.modelDiscovery?.status === 'partial');
  const checkedAt = checks.at(-1);
  async function copy(endpoint: string) {
    try { await copyText(endpoint); setCopied(endpoint); setError(''); }
    catch { setError('Adres kopyalanamadı. Metni seçerek kopyalayabilirsiniz.'); }
  }
  return <section className="model-connections" aria-label="Dil modeli bağlantıları">
    <header><h3><BrainCircuit size={18} /> Dil modeli bağlantıları</h3>{checkedAt && <small>Kontrol: {new Date(checkedAt).toLocaleString('tr-TR')}</small>}</header>
    <p className="model-explanation">{rows.length ? 'Projede tanımlı model adresleri. Bu bilgi, servisin erişilebilir olduğunu veya her istekte kullanıldığını doğrulamaz.' : checkedAt ? 'İncelenen ayarlarda model adresi tespit edilmedi. Bu, uygulamanın model kullanmadığı anlamına gelmez.' : 'Bu uygulama için model bağlantısı henüz tespit edilmedi.'}</p>
    {rows.map(row => <article className="model-connection" key={`${row.endpoint}-${row.model}-${row.role}`}>
      <div className="model-connection-heading"><strong>{row.model || 'Model adı belirlenemedi'}</strong><span>{row.scope === 'process' ? 'Çalışan süreç ayarı' : 'Proje yapılandırması'}</span></div>
      <div className="model-endpoint"><code>{row.endpoint}</code><Button variant="ghost" size="icon-sm" aria-label={`${row.endpoint} model adresini kopyala`} onClick={() => void copy(row.endpoint)}>{copied === row.endpoint ? <Check size={15} /> : <Copy size={15} />}</Button></div>
      <small className="model-ports">İlgili portlar: {row.ports.sort((a,b)=>a-b).map(port => `:${port}`).join(' · ')}</small>
      <details><summary>Tespit kaynağı</summary><ul>{row.evidence.map((evidence, index) => <li key={index}><span>{evidence.kind === 'process' ? 'Süreç ortamı' : evidence.kind === 'config' ? 'Ayar dosyası' : 'Kaynak kod / varsayılan'} · {evidence.key}</span>{evidence.file && <code>{evidence.file}{evidence.line ? `:${evidence.line}` : ''}</code>}</li>)}</ul></details>
    </article>)}
    {partial && <p className="model-explanation">Bazı yapılandırma dosyaları okunamadı; tespit eksik olabilir.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
