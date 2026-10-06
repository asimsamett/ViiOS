export type ServerProcess = {
  pid: number; name: string; user: string; state: string; parentPid: number | null;
  cpuPercent: number | null; memoryBytes: number | null; startedAt: string | null;
  token: string | null; canTerminate: boolean; reason: string;
};
export type ProcessSort = 'pid' | 'name' | 'user' | 'state' | 'cpuPercent' | 'memoryBytes' | 'startedAt';
export function filterProcesses(rows: ServerProcess[], query: string, sort: ProcessSort, descending: boolean) {
  const terms = query.toLocaleLowerCase('tr-TR').trim().split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => `${row.pid} ${row.name} ${row.user} ${row.state}`.toLocaleLowerCase('tr-TR').includes(term))).sort((a,b) => {
    const left = a[sort], right = b[sort];
    if (left === null) return right === null ? a.pid-b.pid : 1;
    if (right === null) return -1;
    const order = typeof left === 'number' && typeof right === 'number' ? left-right : String(left).localeCompare(String(right),'tr');
    return (descending ? -order : order) || a.pid-b.pid;
  });
}
