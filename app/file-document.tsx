'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Download,
  File,
  Folder,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useTarget } from './target-context';
import { useFileRead } from './file-read';
import type { Entry, Viewed } from './file-manager';

type Mutation = (request: Record<string, unknown>) => Promise<unknown>;

export function FileDocument({
  windowId,
  entry,
  locked,
  mutate,
  onDirty,
}: {
  windowId: string;
  entry: Entry;
  locked: boolean;
  mutate: Mutation;
  onDirty: (id: string, dirty: boolean) => void;
}) {
  const { url } = useTarget(),
    read = useFileRead();
  const keyboardRoot = useRef<HTMLElement>(null);
  const [data, setData] = useState<Viewed | null>(null);
  const [content, setContent] = useState(''),
    [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const dirty = !!data && content !== (data.content || '');
  useEffect(() => {
    onDirty(windowId, dirty);
  }, [windowId, dirty, onDirty]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError('');
      void read<Viewed>(
        `/files/read?path=${encodeURIComponent(entry.path)}`,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setData(result);
            setContent(result.content || '');
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError((e as Error).message);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [read, entry.path, reload]);
  async function save() {
    if (!data || saving || locked || !dirty) return;
    setSaving(true);
    setError('');
    try {
      await mutate({
        action: 'write',
        path: data.path,
        revision: data.revision,
        content,
      });
      const current = await read<Viewed>(
        `/files/read?path=${encodeURIComponent(data.path)}`,
      );
      setData(current);
      setContent(current.content || '');
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    const root = keyboardRoot.current;
    const keyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    root?.addEventListener('keydown', keyboard);
    return () => root?.removeEventListener('keydown', keyboard);
  });
  return (
    <section
      ref={keyboardRoot}
      className="desktop-document"
      aria-label={`${entry.name} görüntüleyici`}
    >
      <div className="document-location" title={entry.path}>
        <File size={14} />
        <span>{entry.path}</span>
        {dirty && <b>Kaydedilmedi</b>}
      </div>
      <div className="file-viewer-toolbar">
        <span>
          {data
            ? `${(data.size / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} KB · ${data.kind === 'text' ? 'UTF-8 metin' : data.kind === 'image' ? 'Görsel' : 'Dosya'}`
            : 'Dosya okunuyor…'}
        </span>
        {data?.editable && (
          <Button
            variant="outline"
            disabled={locked || saving}
            onClick={() => setEditing(!editing)}
          >
            <Pencil size={15} />
            {editing ? 'Önizleme' : 'Düzenle'}
          </Button>
        )}
        {data?.editable && (
          <Button
            disabled={!dirty || locked || saving}
            onClick={() => void save()}
          >
            <Save size={15} />
            {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </Button>
        )}
        <a
          className="file-download"
          href={url(`/files/download?path=${encodeURIComponent(entry.path)}`)}
        >
          <Download size={15} />
          İndir
        </a>
      </div>
      {error && (
        <div className="notice error-notice" role="alert">
          <span>{error}</span>
          {!dirty && (
            <Button
              variant="outline"
              disabled={saving || locked}
              onClick={() => setReload((n) => n + 1)}
            >
              Tekrar dene
            </Button>
          )}
        </div>
      )}
      {!data && !error && (
        <div className="files-empty">
          <RefreshCw className="spin" />
        </div>
      )}
      {data?.kind === 'text' &&
        (editing ? (
          <Textarea
            className="file-editor"
            aria-label={`${entry.name} içeriğini düzenle`}
            spellCheck={false}
            value={content}
            disabled={locked || saving}
            onChange={(e) => setContent(e.target.value)}
          />
        ) : (
          <pre className="file-text-preview">
            <code>{content || 'Dosya boş.'}</code>
          </pre>
        ))}
      {data?.kind === 'image' && (
        <div className="file-image-preview">
          <Image
            unoptimized
            width={1400}
            height={900}
            src={url(
              `/files/download?inline=true&path=${encodeURIComponent(entry.path)}&v=${data.revision}`,
            )}
            alt={entry.name}
          />
        </div>
      )}
      {data?.kind === 'binary' && (
        <div className="files-empty">
          <File size={40} />
          <h3>Bu dosyayı indirerek açın</h3>
          <p>
            Metin ve PNG/JPEG/GIF/WebP görselleri bu pencerede açılır. PDF,
            Office ve arşivleri İndir ile bilgisayarınızda
            görüntüleyebilirsiniz.
          </p>
        </div>
      )}
      <footer className="document-status">
        <span>{dirty ? 'Kaydetmek için Ctrl + S' : 'Sunucudaki dosya'}</span>
        <span>
          {data?.editable ? 'Düzenlenebilir · En fazla 1 MB' : 'Önizleme'}
        </span>
      </footer>
    </section>
  );
}

type TrashEntry = {
  id: string;
  root: string;
  path: string;
  name: string;
  kind: string;
  deletedAt: number;
};
export function FileTrash({
  generation,
  locked,
  mutate,
}: {
  generation: number;
  locked: boolean;
  mutate: Mutation;
}) {
  const read = useFileRead();
  const [entries, setEntries] = useState<TrashEntry[]>([]),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      void read<{ entries: TrashEntry[] }>('/files/trash', controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setEntries(data.entries);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError((e as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [read, generation, reload]);
  return (
    <section className="desktop-trash">
      <div className="file-viewer-toolbar">
        <span>Kaldırılan öğeleri eski konumuna geri yükleyin.</span>
        <Button
          variant="outline"
          disabled={loading || locked}
          onClick={() => setReload((n) => n + 1)}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          Yenile
        </Button>
      </div>
      {error && (
        <div className="notice error-notice" role="alert">
          {error}
        </div>
      )}
      <div className="trash-list">
        {entries.map((item) => (
          <article key={item.id}>
            {item.kind === 'directory' ? (
              <Folder size={26} />
            ) : (
              <File size={26} />
            )}
            <div>
              <strong>{item.name}</strong>
              <code>{item.path}</code>
              <small>{new Date(item.deletedAt).toLocaleString('tr-TR')}</small>
            </div>
            <Button
              variant="outline"
              disabled={locked || loading}
              onClick={async () => {
                try {
                  await mutate({
                    action: 'restore',
                    root: item.root,
                    id: item.id,
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <RotateCcw size={15} />
              Geri yükle
            </Button>
          </article>
        ))}
      </div>
      {!entries.length && (
        <div className="files-empty">
          <Trash2 size={40} />
          <h3>{loading ? 'Çöp kutusu okunuyor…' : 'Çöp kutusu boş'}</h3>
        </div>
      )}
      <p className="files-limits">
        Aynı konumda mevcut bir öğe varsa üzerine yazılmaz. Dosya işlemleri
        sunucunun işlem günlüğüne kaydedilir.
      </p>
    </section>
  );
}
