export function storageBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const unit = value === 0 ? 0 : Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** unit).toLocaleString('tr-TR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export function storagePercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : `%${value.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
}
