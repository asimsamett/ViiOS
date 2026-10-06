'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { TeamData } from './team-types';

type TeamMethod = 'POST' | 'PATCH' | 'DELETE' | 'PUT';
type TeamContextValue = {
  data: TeamData | null;
  loading: boolean;
  error: string;
  busy: boolean;
  reload: () => Promise<TeamData | null>;
  mutate: (path: string, method: TeamMethod, body?: Record<string, unknown>, expectedRevision?: number) => Promise<TeamData>;
};

const TeamContext = createContext<TeamContextValue | null>(null);

export function TeamProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<TeamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dataRef = useRef<TeamData | null>(null);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const writing = useRef(false);
  const nextRequest = useCallback(() => ++requestId.current, []);

  const remember = useCallback((value: TeamData) => {
    dataRef.current = value;
    setData(value);
  }, []);

  const reload = useCallback(async () => {
    if (writing.current) return dataRef.current;
    const id = nextRequest();
    setLoading(true);
    setError('');
    try {
      const value = await api<TeamData>('/team');
      if (mounted.current && id === requestId.current) remember(value);
      return value;
    } catch (reason) {
      if (mounted.current && id === requestId.current) setError((reason as Error).message);
      return null;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [remember, nextRequest]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { if (mounted.current) void reload(); });
    return () => {
      mounted.current = false;
      nextRequest();
    };
  }, [reload, nextRequest]);

  const mutate = useCallback(async (path: string, method: TeamMethod, body: Record<string, unknown> = {}, expectedRevision?: number) => {
    if (writing.current) throw new Error('Bir kayıt işlemi sürüyor. Tamamlanmasını bekleyin.');
    const revision = expectedRevision ?? dataRef.current?.revision;
    if (revision === undefined) throw new Error('Kişi bilgileri henüz yüklenmedi. Yenileyip tekrar deneyin.');
    writing.current = true;
    const id = nextRequest();
    setBusy(true);
    setLoading(false);
    setError('');
    try {
      const value = await api<TeamData>(path, {
        method,
        body: JSON.stringify({ ...body, revision }),
      });
      if (mounted.current && id === requestId.current) remember(value);
      return value;
    } catch (reason) {
      const failure = reason as Error & { status?: number };
      let message = failure.message;
      if (failure.status === 409) {
        // Refresh the snapshot for review. The user's pending edit is never
        // submitted again automatically or overwritten with another session's data.
        try {
          const latest = await api<TeamData>('/team');
          if (mounted.current && id === requestId.current) remember(latest);
        } catch {
          message += ' Güncel bilgiler alınamadı; yeniden denemeden önce listeyi yenileyin.';
        }
      }
      if (mounted.current && id === requestId.current) setError(message);
      throw Object.assign(new Error(message), { status: failure.status });
    } finally {
      writing.current = false;
      if (mounted.current && id === requestId.current) setBusy(false);
    }
  }, [remember, nextRequest]);

  return <TeamContext.Provider value={{ data, loading, error, busy, reload, mutate }}>{children}</TeamContext.Provider>;
}

export function useTeam() {
  const context = useContext(TeamContext);
  if (!context) throw new Error('useTeam, TeamProvider içinde kullanılmalıdır.');
  return context;
}
