import { sb, requireAuth } from './_lib.js';

const COLUMNS = [
  'id', 'created_at', 'work_or_personal', 'sub_or_person', 'trade',
  'theme', 'entry_type', 'kind', 'title', 'transcript', 'job_name', 'note_type',
  'priority', 'action_required', 'claude_response',
  'is_open_loop', 'loop_resolved', 'resolved_at', 'loop_code'
].join(',');

// One call gives the page everything it needs: notes, waiting items,
// the contacts they point to, and open Duet handoffs.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!requireAuth(req, res)) return;

  try {
    const [rows, waiting, contacts, handoffs] = await Promise.all([
      sb(`voice_notes?select=${COLUMNS}&order=created_at.desc&limit=2000`),
      sb('waiting_items?select=id,item,job,type,contact_id,date_asked,last_nudge,nudge_count,snooze_until,status,notes,source_note_id,created_at,closed_at&order=date_asked.asc&limit=500'),
      sb('contacts?select=id,name,phone,role&limit=1000'),
      sb('duet_handoffs?select=id,created_at,voice_note_id,request,job_name,status,done_at&order=created_at.desc&limit=500')
    ]);

    // An empty notes table here means the key was silently downgraded to anon.
    if (!rows.length) {
      return res.status(502).json({ error: 'Zero rows returned. Key is not being accepted as service_role.' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: rows.length, rows, waiting, contacts, handoffs });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
