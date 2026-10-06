export type UploadItem = { path: string; file?: File };

function checkPath(path: string) {
  if (path.split('/').some(part => !part || part === '.' || part === '..' || Array.from(part).some(character => character === '\\' || character.charCodeAt(0) < 32)))
    throw new Error('Geçersiz dosya veya klasör yolu.');
  return path;
}

export function filesToUpload(files: File[]): UploadItem[] {
  const directories = new Set<string>();
  const items: UploadItem[] = [];
  for (const file of files) {
    const path = checkPath(file.webkitRelativePath || file.name);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!directories.has(folder)) { directories.add(folder); items.push({ path: folder }); }
    }
    items.push({ path, file });
  }
  return items;
}

// Capture entries synchronously during drop: the browser clears DataTransfer later.
export function droppedUpload(data: DataTransfer): Promise<UploadItem[]> {
  const entries = Array.from(data.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
  if (!entries.length || entries.some(entry => !entry)) return Promise.resolve(filesToUpload(Array.from(data.files)));
  return (async () => {
    const items: UploadItem[] = [];
    const pending = entries.map(entry => ({ entry: entry!, parent: '' })).reverse();
    while (pending.length) {
      const { entry, parent } = pending.pop()!;
      const path = checkPath(parent ? `${parent}/${entry.name}` : entry.name);
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        items.push({ path, file });
      } else if (entry.isDirectory) {
        items.push({ path }); // Includes empty directories.
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children: FileSystemEntry[] = [];
        while (true) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break; // Chromium yields only a batch per call.
          children.push(...batch);
        }
        for (let i = children.length - 1; i >= 0; i--) pending.push({ entry: children[i], parent: path });
      }
    }
    return items;
  })();
}

export function sendUpload(url: string, file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
  if (process.env.NEXT_PUBLIC_VIIOS_DEMO === 'true') return Promise.reject(new Error('Demo modunda dosya yüklenmez. Örnek dosyaları inceleyebilirsiniz.'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: Error) => { signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Management-Request', '1');
    xhr.upload.onprogress = event => progress(event.loaded);
    xhr.onload = () => {
      let body: { error?: string; ok?: boolean } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* HTTP error may not be JSON. */ }
      finish(xhr.status >= 200 && xhr.status < 300 && body.ok ? undefined : new Error(body.error || 'Dosya yüklenemedi.'));
    };
    xhr.onerror = () => finish(new Error('Bağlantı kesildi. Dosyanın durumunu klasörü yenileyerek kontrol edin.'));
    xhr.onabort = () => finish(new Error('Yükleme iptal edildi.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finish(new Error('Yükleme iptal edildi.')); return; }
    xhr.send(file);
  });
}
