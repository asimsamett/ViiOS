import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, hash] = (encoded || '').split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex'));
}
export function createAuth(passwordHash, { secure = false, now = Date.now, cookieName = 'viios_session' } = {}) {
  if (!/^viios_[a-z0-9_]{1,48}$/.test(cookieName)) throw new Error('Invalid session cookie name');
  const sessions = new Map();
  const attempts = new Map();
  const maxAge = 8 * 60 * 60 * 1000;
  const cookie = (token, age) => `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const tokenFrom = req => (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const clean = () => {
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
    for (const [key, item] of attempts) if (item.until <= now()) attempts.delete(key);
  };
  return {
    login: (req, res) => {
      clean();
      const key = req.socket.remoteAddress;
      const record = attempts.get(key) || { count: 0, until: now() + 15 * 60 * 1000 };
      if (record.count >= 8) return res.status(429).json({ error: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.' });
      if (!verifyPassword(req.body?.password, passwordHash)) {
        record.count++; attempts.set(key, record);
        return res.status(401).json({ error: 'Şifre hatalı. Lütfen tekrar deneyin.' });
      }
      attempts.delete(key);
      sessions.delete(tokenFrom(req));
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now() + maxAge);
      res.setHeader('Set-Cookie', cookie(token, maxAge / 1000));
      res.json({ authenticated: true });
    },
    require: (req, res, next) => {
      clean();
      if (!sessions.has(tokenFrom(req))) return res.status(401).json({ error: 'Devam etmek için giriş yapın.' });
      next();
    },
    logout: (req, res) => {
      sessions.delete(tokenFrom(req));
      res.setHeader('Set-Cookie', cookie('', 0));
      res.json({ ok: true });
    },
  };
}

export function protectWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-management-request'] !== '1') return res.status(403).json({ error: 'Geçersiz istek.' });
  const origin = req.headers.origin;
  const allowed = [process.env.APP_ORIGIN, 'http://127.0.0.1:5173', 'http://localhost:5173'].filter(Boolean);
  if (origin) {
    try {
      const url = new URL(origin);
      if (url.host !== req.headers.host && !allowed.includes(origin)) return res.status(403).json({ error: 'Bu kaynaktan gelen isteğe izin verilmiyor.' });
    } catch { return res.status(403).json({ error: 'Geçersiz kaynak.' }); }
  }
  next();
}
