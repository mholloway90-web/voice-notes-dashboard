import { sb, requireAuth, body } from './_lib.js';

// Only these tag fields can be changed from the dashboard.
const EDITABLE = ['job_name', 'sub_or_person', 'trade', 'entry_type', 'priority', 'work_or_personal', 'title'];
const PRIORITIES = ['HIGH', 'MED', 'LOW', null];
const TYPES = ['task', 'observation', 'decision', 'idea', 'reflection', null];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!requireAuth(req, res)) return;

  const b = body(req);
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Missing id' });

  const patch = {};
  for (const k of EDITABLE) {
    if (!(k in (b.fields || {}))) continue;
    let v = b.fields[k];
    v = v === '' || v === undefined ? null : String(v).trim().slice(0, 200);
    patch[k] = v;
  }
  if ('priority' in patch && !PRIORITIES.includes(patch.priority)) return res.status(400).json({ error: 'Bad priority' });
  if ('entry_type' in patch && !TYPES.includes(patch.entry_type)) return res.status(400).json({ error: 'Bad type' });
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

  try {
    const rows = await sb(`voice_notes?id=eq.${id}&select=id,${Object.keys(patch).join(',')}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch
    });
    if (!rows || !rows.length) return res.status(404).json({ error: 'Note not found' });
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
