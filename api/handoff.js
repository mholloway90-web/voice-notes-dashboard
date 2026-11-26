import { sb, requireAuth, body } from './_lib.js';

// Hands a note to Claude Duet by adding a row to duet_handoffs.
// POST {"voice_note_id": 123, "request": "what Duet should do", "job_name": "..."}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const b = body(req);
  const noteId = parseInt(b.voice_note_id, 10);
  const request = String(b.request || '').trim().slice(0, 2000);
  if (!Number.isInteger(noteId)) return res.status(400).json({ error: 'Missing voice_note_id' });
  if (!request) return res.status(400).json({ error: 'Tell Duet what to do' });

  try {
    const rows = await sb('duet_handoffs?select=id,created_at,voice_note_id,request,job_name,status,done_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: { voice_note_id: noteId, request, job_name: b.job_name ? String(b.job_name).slice(0, 200) : null }
    });
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
