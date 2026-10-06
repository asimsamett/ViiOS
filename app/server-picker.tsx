'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from './api';
import ServerConnections, { ServerConnectionWizard } from './server-connections';
import { DEMO_MODE } from '@/lib/public-mode';

type Host = { id: string; host: string; name: string; platform?: 'windows' | 'linux'; status: string; active?: number };
export default function ServerPicker({ selected, onSelect, disabled }: { selected: string; onSelect: (id: string) => void; disabled: boolean }) {
  const [hosts, setHosts] = useState<Host[]>([]), [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false), [adding, setAdding] = useState(false), [revision, setRevision] = useState(0);
  const field = useId();
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | null = null;
    const cancel = () => { clearTimeout(timer); request?.abort(); request = null; };
    async function load() {
      if (!active || document.hidden || request) return;
      const controller = new AbortController(); request = controller;
      try {
        const result = await api<{ servers: Host[] }>('/servers', { signal: controller.signal, cache: 'no-store' });
        if (!active || controller.signal.aborted) return;
        setHosts(result.servers); setError('');
      } catch (reason) { if (active && !controller.signal.aborted) setError((reason as Error).message); }
      finally { if (request === controller) request = null; if (active && !controller.signal.aborted && !document.hidden) timer = setTimeout(() => void load(), 5000); }
    }
    const wake = () => { cancel(); if (!document.hidden) void load(); };
    timer = setTimeout(() => void load(), 0);
    document.addEventListener('visibilitychange', wake); window.addEventListener('viios-connections-changed', wake);
    return () => { active = false; cancel(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('viios-connections-changed', wake); };
  }, [revision]);
  const options = Object.fromEntries(hosts.map(host => [host.id, `${host.name || host.host} · ${host.host}`]));
  return <section className="fleet-panel portable-fleet" aria-label="Sunucu seçimi">
    <div className="fleet-toolbar"><div className="fleet-selector"><label htmlFor={`${field}-server`}><Server size={17}/>Sunucu seç</label><Select value={hosts.some(host => host.id === selected) ? selected : null} onValueChange={id => { if (id) onSelect(id); }} items={options} disabled={disabled || !hosts.length}><SelectTrigger id={`${field}-server`} aria-label="İzlenecek sunucuyu seç"><SelectValue placeholder="Hazır sunucu bulunmuyor"/></SelectTrigger><SelectContent>{hosts.map(host => <SelectItem key={host.id} value={host.id}>{host.name || host.host} · {host.host}</SelectItem>)}</SelectContent></Select></div><Button disabled={disabled || DEMO_MODE} title={DEMO_MODE ? "Gerçek sunucu ekleme demo modunda kapalıdır." : undefined} onClick={() => setAdding(true)}><Plus size={16}/>Sunucu ekle</Button><Button variant="outline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Bağlantıları yönet{expanded ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</Button></div>
    {error && <p className="onboarding-error" role="alert">{error}</p>}
    {expanded && <ServerConnections onSelect={onSelect} disabled={disabled} showAdd={false}/>}
    <ServerConnectionWizard open={adding} onClose={() => setAdding(false)} onCreated={() => { setExpanded(true); refresh(); }}/>
  </section>;
}
