/** Reject unavailable or incomplete responses before replacing a good sample. */
export function overviewIsFresh(value: {status:string;sampledAt:number|null} | null, now = Date.now()): boolean {
  return !!value && value.status === 'online' && value.sampledAt !== null && value.sampledAt <= now + 5000 && now - value.sampledAt <= 60000;
}

export function validateOverview(value: unknown): void {
  if (!value || typeof value !== 'object' || (value as {available?:unknown}).available !== true) throw new Error('Sunucu ölçüm sağlayamıyor.');
  const row = value as Record<string, unknown>;
  if (!['memory','disk'].every(key => row[key] && typeof row[key] === 'object' && !Array.isArray(row[key])) ||
      !['addresses','loadAverage','disks','network','topProcesses'].every(key => Array.isArray(row[key])) ||
      !['disks','network','topProcesses'].every(key => (row[key] as unknown[]).every(item => item && typeof item === 'object')) ||
      typeof row.sampledAt !== 'number' || !Number.isFinite(row.sampledAt)) throw new Error('Sunucudan eksik veya geçersiz ölçüm geldi.');
}
