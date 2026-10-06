'use client';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

const subscribe = (callback: () => void) => { window.addEventListener('management-theme-change', callback); return () => window.removeEventListener('management-theme-change', callback); };
const snapshot = () => document.documentElement.classList.contains('dark');
export const useDarkTheme = () => useSyncExternalStore(subscribe, snapshot, () => false);
export function setTheme(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  window.dispatchEvent(new Event('management-theme-change'));
  try { localStorage.setItem('management-theme', theme); } catch { /* Storage may be unavailable. */ }
}
export default function ThemeToggle() {
  const dark = useDarkTheme();
  function toggle() {
    setTheme(dark ? 'light' : 'dark');
  }
  return <Button className="theme-toggle" variant="ghost" size="icon" onClick={toggle} aria-label={dark ? 'Açık temaya geç' : 'Koyu temaya geç'} title={dark ? 'Açık tema' : 'Koyu tema'} aria-pressed={dark}>{dark ? <Sun /> : <Moon />}</Button>;
}
