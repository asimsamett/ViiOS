'use client';

import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { dockLayout } from './desktop-dock-layout';

/** Keep pointer animation outside React so open windows do not rerender. */
export default function DesktopDock({ children, autoHide = false, keepOpen = false }: {
  children: ReactNode;
  autoHide?: boolean;
  keepOpen?: boolean;
}) {
  const area = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);
  const items = Children.toArray(children);
  const layout = dockLayout(width, items.length);
  const shortcuts = items.slice(1, -1);
  const page = Math.min(Math.floor(offset / layout.pageSize), layout.pages - 1);
  const visible = layout.pages > 1
    ? [items[0], ...shortcuts.slice(page * layout.pageSize, (page + 1) * layout.pageSize), items.at(-1)]
    : items;

  useEffect(() => {
    const stage = area.current?.parentElement;
    if (!stage) return;
    const observer = new ResizeObserver(() => setWidth(stage.clientWidth));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const frame = useRef(0);
  const pointer = useRef<number | null>(null);

  function reset() {
    cancelAnimationFrame(frame.current);
    pointer.current = null;
    dock.current?.querySelectorAll<HTMLElement>('.dock-item').forEach(item => {
      item.style.removeProperty('--dock-scale');
    });
  }

  function magnify(clientX: number) {
    if (!dock.current || !matchMedia('(hover: hover) and (pointer: fine) and (min-width: 761px)').matches ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    pointer.current = clientX;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const root = dock.current;
      if (!root || pointer.current === null) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('.dock-item'));
      const style = getComputedStyle(root);
      const size = parseFloat(style.getPropertyValue('--dock-size'));
      const gap = parseFloat(style.columnGap) || 0;
      const rect = root.getBoundingClientRect();
      // Resting centers remain stable while the icons expand inside this page.
      const width = items.length * size + Math.max(0, items.length - 1) * gap;
      const start = rect.left + rect.width / 2 - width / 2;
      const radius = size * 2.5;
      items.forEach((item, index) => {
        const distance = Math.abs(pointer.current! - (start + index * (size + gap) + size / 2));
        const influence = distance < radius ? (1 + Math.cos(Math.PI * distance / radius)) / 2 : 0;
        item.style.setProperty('--dock-scale', (1 + .65 * influence).toFixed(4));
      });
    });
  }

  useEffect(() => {
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion.addEventListener('change', reset);
    window.addEventListener('resize', reset);
    window.addEventListener('blur', reset);
    return () => {
      cancelAnimationFrame(frame.current);
      reducedMotion.removeEventListener('change', reset);
      window.removeEventListener('resize', reset);
      window.removeEventListener('blur', reset);
    };
  }, []);

  return (
    <div
      ref={area}
      style={{ '--dock-size': `${layout.size}px`, '--dock-gap': `${layout.gap}px` } as CSSProperties}
      className={`desktop-dock-area ${autoHide ? 'auto-hide' : ''} ${keepOpen ? 'is-open' : ''}`}
      onPointerDown={event => { if (event.pointerType === 'touch') dock.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }}
    >
      <div className="macos-dock" role="toolbar" aria-label="ViiOS Dock · Uygulamalar ve açık pencereler">
        {layout.pages > 1 && <button type="button" className="dock-page-button" aria-label="Önceki uygulamalar" title="Önceki uygulamalar" disabled={page === 0} onPointerEnter={reset} onClick={() => { reset(); setOffset((page - 1) * layout.pageSize); }}><ChevronLeft size={18}/></button>}
        <div
          ref={dock}
          className="dock-items"
          onPointerMove={event => { if (event.pointerType !== 'touch') magnify(event.clientX); }}
          onPointerLeave={reset}
          onPointerCancel={reset}
        >{visible}</div>
        {layout.pages > 1 && <button type="button" className="dock-page-button" aria-label="Sonraki uygulamalar" title="Sonraki uygulamalar" disabled={page === layout.pages - 1} onPointerEnter={reset} onClick={() => { reset(); setOffset((page + 1) * layout.pageSize); }}><ChevronRight size={18}/></button>}
        {layout.pages > 1 && <output className="dock-page-status" aria-label="Görev çubuğu sayfası">{page + 1} / {layout.pages}</output>}
      </div>
    </div>
  );
}
