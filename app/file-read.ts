import { useCallback } from 'react';
import { useTarget } from './target-context';

// Several windows can read concurrently; retry only the broker's temporary read lock.
// Mutations and revision conflicts must never be retried automatically.
export function useFileRead() {
  const { api } = useTarget();
  return useCallback(
    async <T>(path: string, signal?: AbortSignal): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          return await api<T>(path, { signal });
        } catch (error) {
          const failure = error as Error & { status?: number };
          if (
            signal?.aborted ||
            attempt >= 5 ||
            failure.status !== 409 ||
            !failure.message.startsWith('Başka bir dosya işlemi sürüyor.')
          )
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 180 * (attempt + 1)),
          );
        }
      }
    },
    [api],
  );
}
