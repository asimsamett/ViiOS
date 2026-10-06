'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from './api';
import Appearance, { useWallpaper } from './appearance';
import ViiBrandIcon from './vii-brand-icon';

export default function SetupScreen({ onConfigured }: { onConfigured: () => void }) {
  const wallpaper = useWallpaper('lock');
  const field = useId();
  const request = useRef<AbortController | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);
  async function configure() {
    if (request.current) return;
    if (password.length < 8) { setError('Yönetici şifresi en az 8 karakter olmalıdır.'); return; }
    if (password !== confirmation) { setError('Şifreler eşleşmiyor.'); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      await api('/setup', { method: 'POST', body: JSON.stringify({ password, confirmPassword: confirmation }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setPassword(''); setConfirmation(''); onConfigured();
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  return <main className="vii-wallpaper onboarding-shell" data-wallpaper={wallpaper}>
    <header className="onboarding-topbar"><span><ViiBrandIcon/><strong>ViiOS</strong><small>Visual Infrastructure Intelligence</small></span><Appearance/></header>
    <section className="setup-card" aria-labelledby={`${field}-title`}>
      <span className="onboarding-hero-icon" aria-hidden="true"><ShieldCheck size={30}/></span>
      <span className="onboarding-eyebrow">İLK KURULUM</span><h1 id={`${field}-title`}>Çalışma alanınızı hazırlayın.</h1><p>Bu ViiOS kurulumu için bir yönetici şifresi oluşturun. Ardından Windows veya Linux sunucularınızı ekleyebilirsiniz.</p>
      <form onSubmit={event => { event.preventDefault(); void configure(); }} autoComplete="off" aria-busy={busy}>
        <label htmlFor={`${field}-password`}>Yönetici şifresi<Input id={`${field}-password`} type="password" autoComplete="new-password" minLength={8} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/><small><KeyRound size={12} aria-hidden="true"/>En az 8 karakter. Büyük harf, rakam veya özel karakter zorunluluğu yoktur.</small></label>
        <label htmlFor={`${field}-confirm`}>Şifreyi tekrar girin<Input id={`${field}-confirm`} type="password" autoComplete="new-password" minLength={8} maxLength={256} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={busy}/>{confirmation && password === confirmation && <small className="onboarding-success"><Check size={12} aria-hidden="true"/>Şifreler eşleşiyor</small>}</label>
        {error && <p className="onboarding-error" role="alert">{error}</p>}
        <Button type="submit" disabled={busy || password.length < 8 || password !== confirmation}>{busy ? <LoaderCircle size={16} className="spin"/> : <LockKeyhole size={16}/>}{busy ? 'Çalışma alanı hazırlanıyor…' : 'Yönetici şifresini oluştur'}{!busy && <ArrowRight size={15}/>}</Button>
      </form>
      <p className="setup-footnote">Bu şifre ViiOS’a giriş içindir. Sunucularınızın SSH bağlantı bilgileri sonraki adımda eklenir.</p>
    </section>
  </main>;
}
