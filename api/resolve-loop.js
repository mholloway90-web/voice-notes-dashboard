import { sb, requireAuth, body } from './_lib.js';

// POST {"id": 123}                    closes the loop
// POST {"id": 123, "resolved": false} reopens it
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const b = body(req);
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Body must be {"id": <number>}' });
  const resolved = b.resolved !== false;

  try {
    const patch = resolved
      ? { loop_resolved: true, resolved_at: new Date().toISOString(), resolved_via: 'dashboard' }
      : { loop_resolved: false, resolved_at: null, resolved_via: null };
    const rows = await sb(`voice_notes?id=eq.${id}&select=id,is_open_loop,loop_resolved,resolved_at`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!rows || !rows.length) return res.status(404).json({ error: 'Nothing was updated. Check the id.' });
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
