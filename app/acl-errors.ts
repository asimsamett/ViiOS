export const ACL_ERROR_EVENT = 'viios-acl-error';
export type AclErrorCode = 'ACL_UNSUPPORTED' | 'ACL_ACCESS_DENIED' | 'ACL_UPDATE_FAILED';
export type AclNotice = { code: AclErrorCode; message: string; operation: string; endpoint: string };

const codes = new Set<string>(['ACL_UNSUPPORTED', 'ACL_ACCESS_DENIED', 'ACL_UPDATE_FAILED']);
const actions: Record<string, string> = { inspect: 'Proje erişimini inceleme', prepare: 'Proje erişimini hazırlama', 'restore-access': 'Önceki izinleri geri yükleme' };

/** Observe a copy: the caller must still receive the original API error body. */
export async function notifyAclError(response: Response, input: RequestInfo | URL, options?: RequestInit): Promise<void> {
  if (response.ok || typeof window === 'undefined' || options?.signal?.aborted) return;
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' || !codes.has(body.code)) return;
    if (options?.signal?.aborted) return;
    const source = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const endpoint = new URL(source, window.location.href).pathname;
    let operation = 'Dosya erişimi';
    if (endpoint.endsWith('/versions/action')) {
      operation = 'Sürüm yönetimi';
      if (typeof options?.body === 'string') {
        try {
          const request: unknown = JSON.parse(options.body);
          if (request && typeof request === 'object' && 'action' in request && typeof request.action === 'string') operation = actions[request.action] || operation;
        } catch { /* Error reporting must not change request behavior. */ }
      }
    }
    const notice: AclNotice = { code: body.code as AclErrorCode, message: 'error' in body && typeof body.error === 'string' ? body.error : 'Dosya izinleri işlemi tamamlanamadı.', operation, endpoint };
    window.dispatchEvent(new CustomEvent<AclNotice>(ACL_ERROR_EVENT, { detail: notice }));
  } catch { /* Non-JSON errors keep their existing handling. */ }
}
