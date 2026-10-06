'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Keep pointer animation outside React so open windows do not rerender. */
export default function DesktopDock({ children, autoHide = false, keepOpen = false }: {
  children: ReactNode;
  autoHide?: boolean;
  keepOpen?: boolean;
}) {
  const dock = useRef<HTMLDivElement>(null);
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
      // Fixed resting centers prevent feedback as the Dock expands sideways.
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
      className={`desktop-dock-area ${autoHide ? 'auto-hide' : ''} ${keepOpen ? 'is-open' : ''}`}
      onPointerDown={event => { if (event.pointerType === 'touch') dock.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }}
    >
      <div
        ref={dock}
        className="macos-dock"
        role="toolbar"
        aria-label="ViiOS Dock · Uygulamalar ve açık pencereler"
        onPointerMove={event => { if (event.pointerType !== 'touch') magnify(event.clientX); }}
        onPointerLeave={reset}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  );
}
