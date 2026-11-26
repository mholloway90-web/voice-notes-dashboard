// Shared helpers for the dashboard API. Files that start with an underscore
// are not exposed as routes by Vercel.
import crypto from 'crypto';

export const SUPABASE_URL = 'https://ecjmqwdijgsycbqkfcog.supabase.co';
const COOKIE = 'vn_session';
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days

// Legacy JWT service_role keys need Authorization: Bearer to get elevated
// privileges. New sb_secret_ keys are rejected on that header.
export function sbHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json', ...(extra || {}) };
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

export async function sb(path, opts) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Server missing Supabase key');
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: (opts && opts.method) || 'GET',
    headers: sbHeaders(opts && opts.headers),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.DASHBOARD_PASSWORD).update(value).digest('hex');
}

export function makeSessionCookie() {
  const exp = String(Date.now() + MAX_AGE * 1000);
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function checkPassword(given) {
  const real = process.env.DASHBOARD_PASSWORD || '';
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return real.length > 0 && crypto.timingSafeEqual(a, b);
}

function isAuthed(req) {
  if (!process.env.DASHBOARD_PASSWORD) return false;
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return good.length === mac.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac));
}

// Returns true when the request may proceed. Otherwise it has already replied.
export function requireAuth(req, res) {
  if (!process.env.DASHBOARD_PASSWORD) {
    res.status(503).json({ error: 'setup', message: 'DASHBOARD_PASSWORD is not set in Vercel yet.' });
    return false;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: 'login' });
    return false;
  }
  return true;
}

export function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}
