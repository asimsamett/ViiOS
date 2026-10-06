import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TIME_ZONE = 'Europe/Istanbul', RETRY_MS = 5 * 60 * 1000;
const FAILED = 'Yönetim panelleri kontrol edilemedi. Mevcut kayıtlar korunuyor; yeniden deneyin.';
const STATUS_FAILED = 'Otomatik kontrol durumu kaydedilemedi. Mevcut uygulama kayıtları korunuyor.';
const INTERRUPTED = 'Önceki kontrol tamamlanmadan servis kapandı. Mevcut kayıtlar korunuyor.';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fail = (message, status = 503) => { throw Object.assign(new Error(message), { status }); };
const validIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const parts = (formatter, at) => Object.fromEntries(formatter.formatToParts(new Date(at)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
export function istanbulDay(at) {
  const value = parts(dateFormat, at);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}
export function nextIstanbulMidnight(at) {
  const current = parts(dateFormat, at), calendar = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const desired = calendar.getTime();
  let instant = desired;
  // Resolve the local calendar midnight through the IANA zone. This avoids
  // depending on the process's host time zone or a permanently fixed offset.
  for (let iteration = 0; iteration < 4; iteration++) {
    const local = parts(clockFormat, instant);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const difference = desired - represented;
    instant += difference;
    if (!difference) break;
  }
  return new Date(instant).toISOString();
}
function initialState(at) {
  return { scanning: false, lastAttemptAt: null, lastAttemptReason: null, lastSuccessAt: null, lastDailyDay: null, nextRunAt: nextIstanbulMidnight(at), retryAfter: null, lastResult: null, warnings: [], lastError: null };
}
function validateState(value) {
  const expected = ['version', 'timeZone', 'schedule', ...Object.keys(initialState(0))];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))
    || value.version !== 1 || value.timeZone !== TIME_ZONE || value.schedule !== '00:00' || typeof value.scanning !== 'boolean'
    || !['manual', 'scheduled', null].includes(value.lastAttemptReason)
    || !validIso(value.nextRunAt) || [value.lastAttemptAt, value.lastSuccessAt, value.retryAfter].some(item => item !== null && !validIso(item))
    || value.lastDailyDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value.lastDailyDay)
    || value.lastError !== null && ![FAILED, STATUS_FAILED, INTERRUPTED].includes(value.lastError)
    || !Array.isArray(value.warnings) || value.warnings.length > 20 || value.warnings.some(item => typeof item !== 'string' || item.length > 500 || /\p{Cc}/u.test(item))) fail(STATUS_FAILED);
  if (value.lastResult !== null && (!value.lastResult || typeof value.lastResult !== 'object' || Object.keys(value.lastResult).length !== 3 || ['added', 'updated', 'unchanged'].some(key => !Number.isSafeInteger(value.lastResult[key]) || value.lastResult[key] < 0))) fail(STATUS_FAILED);
  if (value.scanning && (!value.lastAttemptAt || !value.lastAttemptReason)) fail(STATUS_FAILED);
  const { version: _version, timeZone: _timeZone, schedule: _schedule, ...state } = value;
  return state;
}
function warningsFrom(result) {
  if (result.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.some(item => typeof item !== 'string'))) throw new Error('Invalid discovery warnings.');
  const passwords = result.entries.map(entry => entry.password).filter(value => typeof value === 'string' && value.length > 0);
  return (result.warnings || []).slice(0, 20).map(item => {
    const warning = item.replace(/\p{Cc}/gu, ' ').trim().slice(0, 500);
    return passwords.some(password => warning.includes(password)) ? 'Bir kaynak kontrol edilemedi; kayıtlı bilgiler korundu.' : warning;
  }).filter(Boolean);
}

export function createAppCredentialSync({ store, dataDir, discover, enabled = true, disabledReason = null, now = Date.now }) {
  const directory = path.resolve(dataDir), file = path.join(directory, 'app-credentials-sync.json');
  let state = null, active = null, closed = false, transition = Promise.resolve();
  function serialized(operation) {
    const result = transition.catch(() => {}).then(operation); transition = result; return result;
  }
  const view = () => ({
    enabled, disabledReason: enabled ? null : disabledReason || 'Bu sunucuda otomatik panel keşfi kullanılamıyor.',
    scanning: !!active, timeZone: TIME_ZONE, schedule: '00:00',
    lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt, lastDailyDay: state.lastDailyDay,
    nextRunAt: enabled ? state.retryAfter || state.nextRunAt : null,
    lastResult: state.lastResult ? { ...state.lastResult } : null, warnings: [...state.warnings], lastError: state.lastError,
  });
  async function persist(next) {
    const temporary = path.join(directory, `app-credentials-sync.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, timeZone: TIME_ZONE, schedule: '00:00', ...next }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, file);
    } catch { fail(STATUS_FAILED); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function load() {
    if (state) return;
    if (!enabled) { state = initialState(now()); return; }
    let handle, loaded;
    try {
      handle = await open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('Invalid sync status.');
      loaded = validateState(JSON.parse(await handle.readFile('utf8')));
    } catch (error) { if (error.code !== 'ENOENT') fail(STATUS_FAILED); }
    finally { await handle?.close(); }
    if (!loaded) { loaded = initialState(now()); await persist(loaded); }
    else if (loaded.scanning) {
      loaded = { ...loaded, scanning: false, lastError: INTERRUPTED };
      if (loaded.lastAttemptReason === 'scheduled') loaded.retryAfter = new Date(Math.max(now(), Date.parse(loaded.lastAttemptAt) + RETRY_MS)).toISOString();
      await persist(loaded);
    }
    state = loaded;
  }
  const due = () => Date.parse(state.nextRunAt) <= now() && (!state.retryAfter || Date.parse(state.retryAfter) <= now());
  async function start(reason) {
    if (closed) fail('Panel kontrol servisi kapanıyor.');
    if (!enabled) fail(disabledReason || 'Bu sunucuda otomatik panel keşfi kullanılamıyor.');
    if (active || reason === 'scheduled' && !due()) return view();
    const startedAt = now(), next = { ...state, scanning: true, lastAttemptAt: new Date(startedAt).toISOString(), lastAttemptReason: reason, lastError: null, warnings: [] };
    await persist(next); state = next;
    const job = { reason, startedAt, day: istanbulDay(startedAt), promise: null };
    active = job;
    job.promise = (async () => {
      let outcome;
      try {
        const result = await discover();
        if (!result || !Array.isArray(result.entries)) throw new Error('Invalid discovery result.');
        const warnings = warningsFrom(result), merged = await store.mergeDiscovered(result.entries);
        outcome = { success: true, warnings, counts: { added: merged.added, updated: merged.updated, unchanged: merged.unchanged } };
      } catch { outcome = { success: false }; }
      await serialized(async () => {
        const finishedAt = now();
        let completed = { ...state, scanning: false };
        if (outcome.success) {
          completed = { ...completed, lastSuccessAt: new Date(finishedAt).toISOString(), lastResult: outcome.counts, warnings: outcome.warnings, lastError: null };
          if (job.reason === 'scheduled') completed = { ...completed, lastDailyDay: job.day, nextRunAt: nextIstanbulMidnight(job.startedAt), retryAfter: null };
        } else {
          completed.lastError = FAILED;
          if (job.reason === 'scheduled') completed.retryAfter = new Date(finishedAt + RETRY_MS).toISOString();
        }
        try { await persist(completed); state = completed; }
        catch {
          // A successful merge with failed bookkeeping is safe to re-run: the
          // merge is idempotent. Do not claim a persisted successful check.
          state = { ...state, scanning: false, lastError: STATUS_FAILED, ...(job.reason === 'scheduled' ? { retryAfter: new Date(finishedAt + RETRY_MS).toISOString() } : {}) };
        }
        active = null;
        // A manual scan begun before midnight must not consume the next day's
        // scheduled scan. A pending midnight starts after that scan finishes.
        if (!closed && enabled && due()) {
          try { await start('scheduled'); } catch { state.lastError = STATUS_FAILED; }
        }
      });
    })();
    return view();
  }
  const status = () => serialized(async () => { await load(); return view(); });
  const tick = () => serialized(async () => {
    await load();
    if (!closed && enabled && due()) return start('scheduled');
    return view();
  });
  return {
    initialize: tick,
    status,
    tick,
    trigger: (reason = 'manual') => serialized(async () => {
      if (!['manual', 'scheduled'].includes(reason)) fail('Geçersiz panel kontrol isteği.', 400);
      await load(); return start(reason);
    }),
    async waitForIdle() { await transition.catch(() => {}); while (active) await active.promise; return status(); },
    async close() { closed = true; await transition.catch(() => {}); if (active) await active.promise; },
  };
}
