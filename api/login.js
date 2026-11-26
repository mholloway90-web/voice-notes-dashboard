import { checkPassword, makeSessionCookie, clearSessionCookie, body } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!String(process.env.DASHBOARD_PASSWORD || '').trim()) {
    return res.status(503).json({ error: 'setup', message: 'DASHBOARD_PASSWORD is not set in Vercel yet.' });
  }
  // Small fixed delay slows down password guessing.
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(body(req).password)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', makeSessionCookie());
  return res.status(200).json({ ok: true });
}
