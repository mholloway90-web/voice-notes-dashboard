import { sb, requireAuth, body } from './_lib.js';

// POST {"key": "soledad mountain", "name": "5403 Soledad Mountain", "archived": true}
// archived:false brings the job back.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const b = body(req);
  const key = String(b.key || '').trim().slice(0, 200);
  if (!key || key === 'general') return res.status(400).json({ error: 'Bad job' });

  try {
    if (b.archived === false) {
      await sb(`archived_jobs?job_key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true, row: null });
    }
    const rows = await sb('archived_jobs?select=*', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: { job_key: key, display_name: String(b.name || key).slice(0, 200), archived_at: new Date().toISOString() }
    });
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
