'use client';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

export type PreviewWindow = {
  id: string;
  title: string;
  path: string;
  kind: 'folder' | 'file' | 'tasks' | 'repo' | 'trash' | 'applications' | 'tool';
  minimized: boolean;
  dirty: boolean;
  width: number;
  height: number;
};
type WindowSources = RefObject<Map<string, HTMLDivElement>>;

function Thumbnail({
  item,
  sources,
  enabled,
}: {
  item: PreviewWindow;
  sources: WindowSources;
  enabled: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const source = sources.current.get(item.id),
      target = canvas.current,
      box = frame.current;
    if (!enabled || !source || !target || !box) return;
    const images = new WeakMap<
      HTMLImageElement,
      { src: string; data: string }
    >();
    let timer: ReturnType<typeof setTimeout> | undefined,
      last = 0;
    function paint() {
      timer = undefined;
      if (!source || !target || !box) return;
      last = performance.now();
      const scroll: [
        { scrollTop: number; scrollLeft: number },
        { scrollTop: number; scrollLeft: number },
      ][] = [];
      function copy(node: Node): Node | null {
        if (node.nodeType === Node.TEXT_NODE)
          return document.createTextNode(node.textContent || '');
        if (
          !(node instanceof Element) ||
          [
            'SCRIPT',
            'IFRAME',
            'OBJECT',
            'EMBED',
            'LINK',
            'STYLE',
            'VIDEO',
            'AUDIO',
            'SOURCE',
          ].includes(node.tagName)
        )
          return null;
        // Reuse pixels already loaded in this window; never refetch an image for a thumbnail.
        const clone =
          node instanceof HTMLImageElement
            ? document.createElement('img')
            : (node.cloneNode(false) as Element);
        if (node instanceof HTMLImageElement) {
          for (const attribute of Array.from(node.attributes))
            if (!['src', 'srcset', 'sizes', 'loading'].includes(attribute.name))
              clone.setAttribute(attribute.name, attribute.value);
          if (node.complete && node.naturalWidth) {
            try {
              let cached = images.get(node);
              if (!cached || cached.src !== node.currentSrc) {
                const pixels = document.createElement('canvas'),
                  ratio = Math.min(
                    1,
                    640 / node.naturalWidth,
                    480 / node.naturalHeight,
                  );
                pixels.width = Math.max(
                  1,
                  Math.round(node.naturalWidth * ratio),
                );
                pixels.height = Math.max(
                  1,
                  Math.round(node.naturalHeight * ratio),
                );
                pixels
                  .getContext('2d')
                  ?.drawImage(node, 0, 0, pixels.width, pixels.height);
                cached = {
                  src: node.currentSrc,
                  data: pixels.toDataURL('image/png'),
                };
                images.set(node, cached);
              }
              clone.setAttribute('src', cached.data);
            } catch {
              clone.setAttribute('alt', 'Görsel önizlemesi');
            }
          }
        }
        for (const attribute of Array.from(clone.attributes))
          if (
            ['id', 'name', 'for', 'autofocus', 'role', 'href', 'form'].includes(
              attribute.name,
            ) ||
            attribute.name.startsWith('aria-') ||
            attribute.name.startsWith('on')
          )
            clone.removeAttribute(attribute.name);
        if (clone instanceof HTMLElement) clone.tabIndex = -1;
        for (const child of Array.from(node.childNodes)) {
          const result = copy(child);
          if (result) clone.appendChild(result);
        }
        if (
          node instanceof HTMLInputElement &&
          clone instanceof HTMLInputElement
        ) {
          clone.value = ['password', 'file', 'hidden'].includes(node.type)
            ? ''
            : node.value;
          clone.checked = node.checked;
          clone.removeAttribute('value');
        }
        if (
          node instanceof HTMLTextAreaElement &&
          clone instanceof HTMLTextAreaElement
        )
          clone.value = node.value;
        if (
          node instanceof HTMLSelectElement &&
          clone instanceof HTMLSelectElement
        )
          clone.selectedIndex = node.selectedIndex;
        if (
          node instanceof HTMLCanvasElement &&
          clone instanceof HTMLCanvasElement
        ) {
          try {
            clone.getContext('2d')?.drawImage(node, 0, 0);
          } catch {
            /* A missing bitmap leaves an empty preview only. */
          }
        }
        if (node.scrollTop || node.scrollLeft) scroll.push([node, clone]);
        return clone;
      }
      const snapshot = copy(source);
      if (!snapshot) return;
      const width = source.clientWidth || item.width,
        height = source.clientHeight || item.height;
      const scale = Math.min(
        box.clientWidth / width,
        box.clientHeight / height,
      );
      Object.assign(target.style, {
        width: `${width}px`,
        height: `${height}px`,
        left: `${(box.clientWidth - width * scale) / 2}px`,
        top: `${(box.clientHeight - height * scale) / 2}px`,
        transform: `scale(${scale})`,
      });
      const theme = getComputedStyle(source);
      target.style.fontFamily = theme.fontFamily;
      target.style.fontSize = theme.fontSize;
      target.style.fontWeight = theme.fontWeight;
      target.style.lineHeight = theme.lineHeight;
      target.style.color = theme.color;
      for (const key of ['surface', 'chrome', 'glass', 'ink', 'muted', 'line'])
        target.style.setProperty(
          `--desktop-${key}`,
          theme.getPropertyValue(`--desktop-${key}`),
        );
      if (snapshot instanceof HTMLElement) {
        snapshot.style.width = '100%';
        snapshot.style.height = '100%';
      }
      target.replaceChildren(snapshot);
      for (const [original, clone] of scroll) {
        clone.scrollTop = original.scrollTop;
        clone.scrollLeft = original.scrollLeft;
      }
    }
    function schedule() {
      if (timer === undefined)
        timer = setTimeout(
          paint,
          Math.max(0, 500 - (performance.now() - last)),
        );
    }
    paint();
    const mutations = new MutationObserver(schedule),
      resize = new ResizeObserver(schedule);
    mutations.observe(source, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    resize.observe(source);
    resize.observe(box);
    source.addEventListener('input', schedule, true);
    source.addEventListener('scroll', schedule, true);
    source.addEventListener('load', schedule, true);
    return () => {
      clearTimeout(timer);
      mutations.disconnect();
      resize.disconnect();
      source.removeEventListener('input', schedule, true);
      source.removeEventListener('scroll', schedule, true);
      source.removeEventListener('load', schedule, true);
      target.replaceChildren();
    };
  }, [enabled, item.id, item.width, item.height, sources]);
  return (
    <div className="taskbar-thumbnail" ref={frame} aria-hidden="true" inert>
      <div ref={canvas} className="taskbar-preview-canvas" />
    </div>
  );
}

export default function TaskbarPreview({
  dock = false,
  label,
  kind,
  icon,
  windows,
  sources,
  activeId,
  open,
  onOpenChange,
  onActivate,
  onMinimize,
  onClose,
  onLaunch,
  busy,
}: {
  dock?: boolean;
  label: string;
  kind: PreviewWindow['kind'];
  icon: ReactNode;
  windows: PreviewWindow[];
  sources: WindowSources;
  activeId?: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onActivate: (id: string) => void;
  onMinimize: (id: string) => void;
  onClose: (id: string) => void;
  onLaunch?: () => void;
  busy: boolean;
}) {
  const popup = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLElement>(null),
    keyboardFocus = useRef(false);
  const triggerId = useId(),
    popupId = useId();
  const active = windows.some((item) => item.id === activeId),
    dirty = windows.some((item) => item.dirty);
  useEffect(() => {
    if (!open || !keyboardFocus.current) return;
    const timer = setTimeout(() => {
      popup.current
        ?.querySelector<HTMLButtonElement>('.taskbar-preview-open')
        ?.focus();
      keyboardFocus.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);
  function activate(id: string) {
    onOpenChange(false);
    onActivate(id);
  }
  return (
    <HoverCard
      open={open && windows.length > 0}
      triggerId={triggerId}
      onOpenChange={(value) => onOpenChange(value && windows.length > 0)}
    >
      <HoverCardTrigger
        id={triggerId}
        ref={(node) => {
          trigger.current = node;
        }}
        delay={dock ? 800 : 250}
        closeDelay={200}
        render={<button type="button" aria-label={label} />}
        className={`taskbar-tab ${dock ? 'dock-button' : ''} ${kind === 'folder' ? 'taskbar-explorer' : ''} ${active ? 'active' : ''} ${windows.length && windows.every((item) => item.minimized) ? 'minimized' : ''} ${windows.length ? 'has-windows' : ''} ${windows.length > 1 ? 'grouped' : ''}`}
        data-kind={kind}
        aria-label={`${label}${windows.length ? ` · ${windows.length} açık pencere` : ''}${dirty ? ' · Kaydedilmemiş değişiklikler' : ''}`}
        aria-pressed={active}
        aria-expanded={open && windows.length > 0}
        aria-controls={open ? popupId : undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' && windows.length) {
            e.preventDefault();
            keyboardFocus.current = true;
            onOpenChange(true);
            if (open) {
              popup.current
                ?.querySelector<HTMLButtonElement>('.taskbar-preview-open')
                ?.focus();
              keyboardFocus.current = false;
            }
          }
        }}
        onClick={() => {
          if (!windows.length) {
            onLaunch?.();
            return;
          }
          if (windows.length > 1) {
            onOpenChange(true);
            return;
          }
          onOpenChange(false);
          if (activeId === windows[0].id) onMinimize(windows[0].id);
          else onActivate(windows[0].id);
        }}
      >
        {dock ? <><span className="dock-icon" aria-hidden="true">{icon}</span><span className="dock-label" aria-hidden="true">{label}</span></> : icon}
        {dirty && <span className="taskbar-dirty" aria-hidden="true" />}
      </HoverCardTrigger>
      <HoverCardContent
        ref={popup}
        id={popupId}
        side="top"
        sideOffset={dock ? 54 : 10}
        className={`taskbar-preview-popup ${dock ? 'dock-preview-popup' : ''}`}
        aria-label={`${label} pencere önizlemeleri`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onOpenChange(false);
            trigger.current?.focus();
          }
        }}
      >
        <div className="taskbar-preview-list">
          {windows.map((item) => (
            <article
              key={item.id}
              className={`taskbar-preview-card ${item.id === activeId ? 'active' : ''}`}
            >
              <header>
                <span className="taskbar-preview-icon">{icon}</span>
                <span title={item.path}>
                  {item.title}
                  {item.dirty ? ' ●' : ''}
                </span>
                <button
                  type="button"
                  className="taskbar-preview-close"
                  disabled={busy}
                  title="Pencereyi kapat"
                  aria-label={`${item.title} penceresini kapat`}
                  onClick={() => {
                    onOpenChange(false);
                    onClose(item.id);
                  }}
                >
                  <X size={15} />
                </button>
              </header>
              <div className="taskbar-preview-image">
                <Thumbnail item={item} sources={sources} enabled={open} />
                <button
                  type="button"
                  className="taskbar-preview-open"
                  aria-label={`${item.title} penceresine geç${item.minimized ? ' · Küçültülmüş' : ''}`}
                  onClick={() => activate(item.id)}
                />
                {item.minimized && (
                  <span className="taskbar-preview-minimized">Küçültüldü</span>
                )}
              </div>
            </article>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
