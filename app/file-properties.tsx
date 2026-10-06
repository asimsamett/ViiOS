'use client';
import { useEffect, useState } from 'react';
import {
  Copy,
  File,
  Folder,
  Info,
  Link,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTarget } from './target-context';
import { copyText, clientFetch as fetch } from './api';

export type PropertiesItem = {
  path: string;
  name: string;
  kind: 'directory' | 'file' | 'link' | 'special';
};
type Properties = PropertiesItem & {
  parent: string;
  mode: string;
  permissions: string;
  owner: string;
  group: string;
  uid: number;
  gid: number;
  sizeBytes: number | null;
  allocatedBytes: number | null;
  files: number;
  directories: number;
  links: number;
  special: number;
  modifiedAt: number;
  accessedAt: number;
  metadataChangedAt: number;
  scannedAt: number;
  restricted: boolean;
  partial: boolean;
  skipped: number;
  changed: boolean;
  timedOut: boolean;
  sharedReferences: number;
};
const number = (value: number) => value.toLocaleString('tr-TR');
function bytes(value: number | null) {
  if (value === null) return 'Hesaplanamıyor';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const power =
    value > 0
      ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
      : 0;
  return `${(value / 1024 ** power).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ${units[power]}`;
}
const date = (value: number) =>
  new Date(value).toLocaleString('tr-TR', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
const kinds = {
  directory: 'Klasör',
  file: 'Dosya',
  link: 'Sembolik bağlantı',
  special: 'Özel sistem öğesi',
};

export default function FileProperties({
  item,
  host,
  onClose,
  onMessage,
  onPathCopied,
}: {
  item: PropertiesItem;
  host: string;
  onClose: () => void;
  onMessage: (message: string) => void;
  onPathCopied: (path: string) => void;
}) {
  const { url } = useTarget();
  const [data, setData] = useState<Properties | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      url(`/files/properties?${new URLSearchParams({ path: item.path })}`),
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as Properties & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(result.error || 'Özellikler okunamadı.');
        if (!controller.signal.aborted) setData(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [item.path, refresh, url]);
  const Icon =
    item.kind === 'directory' ? Folder : item.kind === 'link' ? Link : File;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="file-properties-dialog">
        <DialogHeader>
          <DialogTitle>Özellikler</DialogTitle>
          <DialogDescription>
            {host} · {kinds[item.kind]}
          </DialogDescription>
        </DialogHeader>
        <div className="file-properties-name">
          <Icon size={42} />
          <strong>{item.name}</strong>
        </div>
        <dl className="file-properties-details">
          <dt>Konum</dt>
          <dd className="file-properties-path">{item.path}</dd>
          <dt>Tür</dt>
          <dd>{kinds[data?.kind || item.kind]}</dd>
        </dl>
        {loading && (
          <output className="file-properties-loading">
            <RefreshCw size={18} className="spin" />
            <span>
              {item.kind === 'directory'
                ? 'Klasör boyutu ve içeriği hesaplanıyor…'
                : 'Özellikler okunuyor…'}
            </span>
          </output>
        )}
        {error && (
          <div className="file-properties-notice has-error" role="alert">
            <Info size={18} />
            <span>{error}</span>
          </div>
        )}
        {data && (
          <>
            <div className="file-properties-sizes">
              <div>
                <span>Boyut{data.partial ? ' · Hesaplanan' : ''}</span>
                <strong>{bytes(data.sizeBytes)}</strong>
                {data.sizeBytes !== null && (
                  <small>{number(data.sizeBytes)} bayt</small>
                )}
              </div>
              <div>
                <span>Diskte ayrılan alan</span>
                <strong>{bytes(data.allocatedBytes)}</strong>
                {data.allocatedBytes !== null && (
                  <small>{number(data.allocatedBytes)} bayt</small>
                )}
              </div>
            </div>
            {data.kind === 'directory' && !data.restricted && (
              <dl className="file-properties-details">
                <dt>İçerik</dt>
                <dd>
                  {number(data.files)} dosya, {number(data.directories)} klasör
                  {data.links > 0 ? `, ${number(data.links)} bağlantı` : ''}
                  {data.special > 0 ? `, ${number(data.special)} özel öğe` : ''}
                </dd>
              </dl>
            )}
            {(data.restricted || data.partial) && (
              <output className="file-properties-notice">
                {data.restricted ? (
                  <LockKeyhole size={18} />
                ) : (
                  <Info size={18} />
                )}
                <span>
                  {data.restricted
                    ? 'Bu alan korumalı. Yalnız görülebilen öğe bilgileri gösterilir; klasörün içeriği hesaplanmaz.'
                    : `Kısmi hesaplama. ${data.skipped ? `${number(data.skipped)} öğe veya alt klasör hesaplanamadı. ` : ''}${data.timedOut ? 'Hesaplama henüz tamamlanmadı; daha dar bir klasör seçebilir veya yeniden hesaplayabilirsiniz. ' : ''}${data.changed ? 'Tarama sırasında değişiklik algılandı. ' : ''}Gösterilen değerler klasörün tam güncel toplamı olmayabilir.`}
                </span>
              </output>
            )}
            <dl className="file-properties-details file-properties-metadata">
              <dt>Değiştirilme</dt>
              <dd>{date(data.modifiedAt)}</dd>
              <dt>Son erişim</dt>
              <dd>{date(data.accessedAt)}</dd>
              <dt>Sahip</dt>
              <dd>
                {data.owner}{' '}
                <span className="file-properties-secondary">
                  (UID {data.uid})
                </span>
              </dd>
              <dt>Grup</dt>
              <dd>
                {data.group}{' '}
                <span className="file-properties-secondary">
                  (GID {data.gid})
                </span>
              </dd>
              <dt>İzinler</dt>
              <dd>
                <code>
                  {data.mode} · {data.permissions}
                </code>
              </dd>
            </dl>
            {data.kind === 'directory' && !data.restricted && (
              <p className="file-properties-note">
                Alt ve gizli klasörler dahildir; sembolik bağlantıların
                hedefleri sayılmaz.
                {data.sharedReferences > 0 &&
                  ` ${number(data.sharedReferences)} ek dosya adı aynı veriyi paylaşıyor. Boyutta her dosya adı, disk alanında aynı veri bir kez sayılır.`}
              </p>
            )}
          </>
        )}
        <footer className="file-properties-actions">
          <Button
            variant="outline"
            onClick={() =>
              void copyText(item.path)
                .then(() => {
                  onPathCopied(item.path);
                  onMessage('Yol kopyalandı.');
                })
                .catch((error) => onMessage((error as Error).message))
            }
          >
            <Copy size={15} /> Yolu kopyala
          </Button>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              setData(null);
              setError('');
              setLoading(true);
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={15} /> Yeniden hesapla
          </Button>
          <Button onClick={onClose}>Tamam</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
