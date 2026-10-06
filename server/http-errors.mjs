import { versionAccessErrorCode } from './versioning.mjs';

export function apiErrorMiddleware(error, _req, res, _next) {
  if (res.headersSent) return;
  const message = error.type === 'entity.parse.failed' ? 'Geçersiz JSON isteği.'
    : error.type === 'entity.too.large' ? 'İstek gövdesi çok büyük.'
      : error.status ? error.message : 'İşlem tamamlanamadı.';
  res.status(error.status || 500).json({ error: message,
    ...(versionAccessErrorCode(error.code) ? { code: error.code } : {}) });
}
