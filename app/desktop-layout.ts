'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { cleanLaunchItem, type LaunchItem } from './launcher-data';
import { useTarget } from './target-context';

export type DesktopLayoutLists = { dock: LaunchItem[] | null; desktop: LaunchItem[] | null };
export type DesktopLayout = DesktopLayoutLists & { version: 1; revision: number };

function readLayout(value: unknown): DesktopLayout {
  if (!value || typeof value !== 'object') throw new Error('Kısayol düzeni okunamadı.');
  const data = value as Partial<DesktopLayout>;
  if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision! < 0) throw new Error('Kısayol düzeni geçersiz.');
  const list = (items: unknown, limit: number): LaunchItem[] | null => {
    if (items === null) return null;
    if (!Array.isArray(items) || items.length > limit) throw new Error('Kısayol listesi geçersiz.');
    const cleaned = items.map(cleanLaunchItem);
    if (cleaned.some(item => !item) || new Set(cleaned.map(item => item!.id)).size !== cleaned.length) throw new Error('Kısayol listesi geçersiz.');
    return cleaned as LaunchItem[];
  };
  return { version: 1, revision: data.revision!, dock: list(data.dock, 32), desktop: list(data.desktop, 16) };
}

export function useDesktopLayout() {
  const { api, id } = useTarget();
  const [state, setState] = useState<{ id: string; layout: DesktopLayout | null }>({ id, layout: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const currentId = useRef(id);
  const active = useRef(false);
  const latest = useRef<{ id: string; layout: DesktopLayout } | null>(null);
  const request = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const sequence = useRef(0);

  const cancelRequest = useCallback(() => {
    // Cancel the latest request, including one started after the effect setup.
    request.current?.abort();
    writing.current = false;
    sequence.current++;
  }, []);

  const reload = useCallback(async () => {
    if (writing.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revision = ++sequence.current;
    setLoading(true);
    try {
      const layout = readLayout(await api<unknown>('/desktop-layout', { signal: controller.signal }));
      if (controller.signal.aborted || !active.current || currentId.current !== id || revision !== sequence.current) return;
      latest.current = { id, layout };
      setState({ id, layout });
      setError('');
    } catch (reason) {
      if (!controller.signal.aborted && active.current && currentId.current === id && revision === sequence.current) {
        setError(reason instanceof Error ? reason.message : 'Kısayol düzeni yüklenemedi.');
      }
    } finally {
      if (!controller.signal.aborted && active.current && currentId.current === id && revision === sequence.current) setLoading(false);
    }
  }, [api, id]);

  useLayoutEffect(() => {
    currentId.current = id;
    active.current = true;
    latest.current = null;
    const timer = setTimeout(() => { setSaving(false); void reload(); }, 0);
    return () => { active.current = false; clearTimeout(timer); cancelRequest(); };
  }, [id, reload, cancelRequest]);

  const save = useCallback(async (value: DesktopLayoutLists) => {
    if (writing.current || loading || latest.current?.id !== id) return false;
    writing.current = true;
    setSaving(true);
    setError('');
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const revision = ++sequence.current;
    try {
      const layout = readLayout(await api<unknown>('/desktop-layout', {
        method: 'PUT', signal: controller.signal,
        body: JSON.stringify({ revision: latest.current.layout.revision, dock: value.dock, desktop: value.desktop }),
      }));
      if (controller.signal.aborted || !active.current || currentId.current !== id || revision !== sequence.current) return false;
      latest.current = { id, layout };
      setState({ id, layout });
      return true;
    } catch (reason) {
      if (!controller.signal.aborted && active.current && currentId.current === id && revision === sequence.current) setError(reason instanceof Error ? reason.message : 'Kısayol düzeni kaydedilemedi.');
      return false;
    } finally {
      if (revision === sequence.current) {
        writing.current = false;
        if (active.current && currentId.current === id) setSaving(false);
      }
    }
  }, [api, id, loading]);

  return { layout: state.id === id ? state.layout : null, loading, saving, error, save, reload };
}
