import { DEMO_MODE } from '@/lib/public-mode';
import { notifyAclError } from './acl-errors';

/** Every application data request uses this transport, including file/report reads. */
export async function clientFetch(input: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  if (DEMO_MODE) {
    const { demoFetch } = await import('../demo/api.mjs');
    return demoFetch(input, options);
  }
  const response = await fetch(input, options);
  await notifyAclError(response, input, options);
  return response;
}

export async function api<T=Record<string,unknown>>(path: string, options?: RequestInit): Promise<T> {
  const headers=new Headers(options?.headers);headers.set('Content-Type','application/json');headers.set('X-Management-Request','1');
  const r = await clientFetch(`/api${path}`, { ...options, headers });
  const d = await r.json() as T & {error?:string;code?:string};
  if (!r.ok) throw Object.assign(new Error(d.error || 'İşlem tamamlanamadı.'), { status: r.status, code: d.code });
  return d;
}
export async function downloadReport(path:string,prefix='/api/reports/') {
  const r=await clientFetch(`${prefix}${path}`);
  if(!r.ok){const body=await r.json() as {error?:string};throw new Error(body.error || 'Rapor indirilemedi.');}
  const blob=await r.blob(),url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download=/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'management-report.csv';
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function copyText(value:string) {
  // Clipboard API requires HTTPS. The deployed intranet panel also supports HTTP.
  if(navigator.clipboard && window.isSecureContext){await navigator.clipboard.writeText(value);return;}
  const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';
  document.body.appendChild(input);input.select();
  // HTTP intranet deployments cannot use the secure-context Clipboard API.
  // eslint-disable-next-line typescript/no-deprecated
  const ok=document.execCommand('copy');input.remove();
  if(!ok)throw new Error('Kopyalanamadı. Port numarasını seçip elle kopyalayabilirsiniz.');
}
