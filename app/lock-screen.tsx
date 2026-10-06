'use client';

import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from 'lucide-react';
import { api } from './api';
import Appearance, { useWallpaper } from './appearance';
import ViiBrandIcon from './vii-brand-icon';
import './lock-screen.css';

const dateFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', weekday: 'long', day: 'numeric', month: 'long' });
const timeFormat = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export default function LockScreen({ onLogin, pending = false, notice = '' }: { onLogin: () => void; pending?: boolean; notice?: string }) {
  const wallpaper = useWallpaper('lock');
  const fieldId = useId();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const update = () => setNow(new Date());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => { clearTimeout(first); clearInterval(timer); request.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!pending && !busy) input.current?.focus({ preventScroll: true });
  }, [pending, busy]);

  async function unlock(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || request.current || !password) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setVisible(false);
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setPassword(''); onLogin();
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Giriş yapılamadı. Lütfen tekrar deneyin.');
    } finally {
      if (!controller.signal.aborted) { request.current = null; setBusy(false); }
    }
  }

  return <main className="vii-wallpaper vii-lock" data-wallpaper={wallpaper} aria-label="ViiOS kilit ekranı">
    <div className="vii-lock-aura" aria-hidden="true"/>
    <header className="vii-lock-header">
      <span className="vii-lock-wordmark"><ViiBrandIcon/><span>Vii<span>OS</span></span></span>
      <div className="vii-lock-header-actions"><span className="vii-lock-status"><LockKeyhole size={13} aria-hidden="true"/><span>Yönetici oturumu</span></span><Appearance/></div>
    </header>

    <div className="vii-lock-stage">
      <time className="vii-lock-clock" dateTime={now?.toISOString()} aria-label={now ? `${dateFormat.format(now)}, saat ${timeFormat.format(now)}` : 'Saat yükleniyor'}>
        <span className="vii-lock-date">{now ? dateFormat.format(now) : '\u00a0'}</span>
        <span className="vii-lock-time" aria-hidden="true">{now ? timeFormat.format(now) : '—:—'}</span>
      </time>

      <section className="vii-lock-identity" aria-label="Yönetici girişi">
        <p className="vii-lock-tagline">Visual Infrastructure Intelligence</p>
        <p className="vii-lock-account">Yönetici</p>
        {notice && <p className="vii-lock-hint" aria-live="polite">{notice}</p>}

        {pending ? <output className="vii-lock-pending"><LoaderCircle size={21} className="vii-lock-spinner" aria-hidden="true"/><span>Oturumunuz kontrol ediliyor…</span></output> : <form className="vii-lock-form" onSubmit={event => { void unlock(event); }} aria-busy={busy}>
          <label className="vii-lock-sr-only" htmlFor={`${fieldId}-password`}>Yönetici şifresi</label>
          <div className={`vii-lock-password${error ? ' has-error' : ''}`}>
            <input ref={input} className="vii-lock-input" id={`${fieldId}-password`} name="password" type={visible ? 'text' : 'password'} value={password} required maxLength={256} autoComplete="current-password" autoCapitalize="none" spellCheck={false} placeholder="Şifre" disabled={busy} aria-invalid={!!error} aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ''}${capsLock ? ` ${fieldId}-caps` : ''}`}
              onChange={event => { setPassword(event.target.value); if (error) setError(''); }}
              onKeyDown={event => { setCapsLock(event.getModifierState('CapsLock')); if (event.key === 'Escape') setVisible(false); }}
              onKeyUp={event => setCapsLock(event.getModifierState('CapsLock'))}
              onBlur={() => setCapsLock(false)}/>
            <button className="vii-lock-reveal" type="button" disabled={busy} aria-label={visible ? 'Şifreyi gizle' : 'Şifreyi göster'} aria-pressed={visible} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff size={17} aria-hidden="true"/> : <Eye size={17} aria-hidden="true"/>}</button>
            <button className="vii-lock-submit" type="submit" disabled={busy || !password} aria-label={busy ? 'Giriş yapılıyor' : 'Masaüstünü aç'} title="Masaüstünü aç">{busy ? <LoaderCircle size={19} className="vii-lock-spinner" aria-hidden="true"/> : <ArrowRight size={20} aria-hidden="true"/>}</button>
          </div>
          <div className="vii-lock-feedback">
            {error && <p id={`${fieldId}-error`} className="vii-lock-error" role="alert">{error}</p>}
            {busy ? <output className="vii-lock-hint">Giriş yapılıyor…</output> : capsLock ? <p id={`${fieldId}-caps`} className="vii-lock-caps">Caps Lock açık</p> : <p id={`${fieldId}-hint`} className="vii-lock-hint">Masaüstünü açmak için şifrenizi girin.</p>}
            {(busy || capsLock) && <span id={`${fieldId}-hint`} className="vii-lock-sr-only">Masaüstünü açmak için şifrenizi girin.</span>}
          </div>
        </form>}
      </section>
    </div>

    <footer className="vii-lock-footer"><LockKeyhole size={12} aria-hidden="true"/><span>Çalışma alanınız sizi bekliyor.</span></footer>
  </main>;
}
