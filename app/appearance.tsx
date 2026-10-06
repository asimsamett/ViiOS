'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { Check, Moon, Palette, Sun } from 'lucide-react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { setTheme, useDarkTheme } from './theme-toggle';
import './appearance.css';

const wallpapers = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'ocean', label: 'Okyanus' },
  { id: 'forest', label: 'Orman' },
  { id: 'sunset', label: 'Gün batımı' },
] as const;
type Wallpaper = typeof wallpapers[number]['id'];
type Surface = 'lock' | 'desktop';
const defaults: Record<Surface, Wallpaper> = { lock: 'aurora', desktop: 'ocean' };
const memory: Partial<Record<Surface, Wallpaper>> = {};
const key = (surface: Surface) => `viios-wallpaper-${surface}`;
function readWallpaper(surface: Surface): Wallpaper {
  if (memory[surface]) return memory[surface];
  let value: string | null = null;
  try { value = localStorage.getItem(key(surface)); } catch { /* Use the default until a selection is made. */ }
  return wallpapers.find(item => item.id === value)?.id ?? defaults[surface];
}
function subscribe(callback: () => void) {
  const storageChanged = () => { delete memory.lock; delete memory.desktop; callback(); };
  window.addEventListener('viios-appearance-change', callback);
  window.addEventListener('storage', storageChanged);
  return () => { window.removeEventListener('viios-appearance-change', callback); window.removeEventListener('storage', storageChanged); };
}
export function useWallpaper(surface: Surface) {
  return useSyncExternalStore(subscribe, () => readWallpaper(surface), () => defaults[surface]);
}
function selectWallpaper(surface: Surface, wallpaper: Wallpaper) {
  memory[surface] = wallpaper;
  try { localStorage.setItem(key(surface), wallpaper); } catch { /* The selection still works for this session. */ }
  window.dispatchEvent(new Event('viios-appearance-change'));
}

/** Keep portalled dialogs and app windows on the same persisted desktop palette. */
export function AppearanceTheme() {
  useEffect(() => {
    const update = () => { document.documentElement.dataset.viiosPalette = readWallpaper('desktop'); };
    update();
    return subscribe(update);
  }, []);
  return null;
}

export default function Appearance({ open, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const dark = useDarkTheme();
  const lock = useWallpaper('lock');
  const desktop = useWallpaper('desktop');
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger className="vii-appearance-trigger" aria-label="Görünüm" title="Görünüm"><Palette size={17}/></PopoverTrigger>
    <PopoverContent align="end" sideOffset={9} className="vii-appearance-panel">
      <PopoverTitle>Görünüm</PopoverTitle>
      <fieldset className="vii-appearance-theme"><legend>Tema</legend>
        <button type="button" aria-pressed={!dark} onClick={() => setTheme('light')}><Sun size={15}/>Açık</button>
        <button type="button" aria-pressed={dark} onClick={() => setTheme('dark')}><Moon size={15}/>Koyu</button>
      </fieldset>
      <p className="vii-appearance-hint">Masaüstü seçiminiz, uygulamaların vurgu renklerine ve pencere yüzeylerine de yansır.</p>
      {([{ surface: 'lock', label: 'Kilit ekranı', selected: lock }, { surface: 'desktop', label: 'Masaüstü', selected: desktop }] as const).map(({ surface, label, selected }) => <fieldset key={surface} className="vii-appearance-wallpapers"><legend>{label}</legend>
        {wallpapers.map(item => <button key={item.id} type="button" aria-label={`${label}: ${item.label}`} aria-pressed={selected === item.id} onClick={() => selectWallpaper(surface, item.id)}>
          <span className="vii-appearance-swatch" data-wallpaper={item.id}>{selected === item.id && <Check size={18}/>}</span><span>{item.label}</span>
        </button>)}
      </fieldset>)}
    </PopoverContent>
  </Popover>;
}
