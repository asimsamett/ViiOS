// Public telemetry contract. Never forward agent objects, command lines or env.
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => { const result = number(value); return result !== null && result <= 100 ? result : null; };
const text = (value, limit = 200) => typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, limit) : '';
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const rates = value => list(value).slice(0, 128).map(value => {
  const row = object(value);
  return { name: text(row.name), readBytesPerSecond: number(row.readBytesPerSecond), writeBytesPerSecond: number(row.writeBytesPerSecond) };
});

export function serverOverview(sample, now = Date.now()) {
  const source = object(sample), system = object(source.system), extra = object(source.overview);
  const memory = object(system.memory), disk = object(system.disk);
  const sampledAt = number(source.sampledAt);
  const fresh = source.available === true && sampledAt !== null && sampledAt <= now + 5000 && now - sampledAt <= 60000;
  return {
    version: 1, available: source.available === true, status: fresh ? 'online' : 'unavailable',
    serverId: text(source.serverId, 40), host: text(source.host), hostname: text(source.hostname), sampledAt,
    extended: extra.version === 1, platform: ['linux', 'windows'].includes(extra.platform) ? extra.platform : null,
    os: text(extra.os), kernel: text(extra.kernel), addresses: list(extra.addresses).slice(0, 64).map(value => text(value, 80)),
    cpuPercent: percent(system.cpuPercent), cpuCount: number(system.cpuCount), uptimeSeconds: number(system.uptimeSeconds),
    processCount: number(system.processCount), loadAverage: list(system.loadAverage).slice(0, 3).map(number),
    cpuTemperatureC: typeof extra.cpuTemperatureC === 'number' && Number.isFinite(extra.cpuTemperatureC) && extra.cpuTemperatureC >= -20 && extra.cpuTemperatureC <= 150 ? extra.cpuTemperatureC : null,
    memory: { totalBytes: number(memory.totalBytes), usedBytes: number(memory.usedBytes), percent: percent(memory.percent), swapTotalBytes: number(memory.swapTotalBytes), swapUsedBytes: number(memory.swapUsedBytes) },
    disk: { totalBytes: number(disk.totalBytes), usedBytes: number(disk.usedBytes), availableBytes: number(disk.availableBytes), percent: percent(disk.percent), volumeCount: number(disk.volumeCount) },
    disks: rates(extra.disks), network: rates(extra.network),
    topProcesses: list(extra.topProcesses).slice(0, 10).map(value => {
      const row = object(value);
      return { pid: number(row.pid), name: text(row.name), cpuPercent: percent(row.cpuPercent), memoryBytes: number(row.memoryBytes), state: text(row.state, 32) };
    }),
  };
}
