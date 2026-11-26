import { sb, requireAuth, body } from './_lib.js';

function today(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// POST {"id": "<uuid>", "action": "done" | "snooze" | "nudge" | "reopen"}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const b = body(req);
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });

  try {
    let patch;
    if (b.action === 'done') patch = { status: 'done', closed_at: new Date().toISOString() };
    else if (b.action === 'reopen') patch = { status: 'open', closed_at: null, snooze_until: null };
    else if (b.action === 'snooze') patch = { snooze_until: today(3) };
    else if (b.action === 'nudge') {
      const cur = await sb(`waiting_items?id=eq.${id}&select=nudge_count`);
      if (!cur.length) return res.status(404).json({ error: 'Not found' });
      patch = { nudge_count: (cur[0].nudge_count || 0) + 1, last_nudge: today(0) };
    } else return res.status(400).json({ error: 'Unknown action' });

    const rows = await sb(`waiting_items?id=eq.${id}&select=*`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
