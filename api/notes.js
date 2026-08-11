const SUPABASE_URL = 'https://ecjmqwdijgsycbqkfcog.supabase.co';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server missing Supabase key' });
  }

  const columns = [
    'id', 'created_at', 'work_or_personal', 'sub_or_person', 'trade',
    'theme', 'entry_type', 'transcript', 'job_name', 'note_type',
    'priority', 'action_required', 'is_open_loop', 'loop_resolved',
    'resolved_at'
  ].join(',');

  const url =
    `${SUPABASE_URL}/rest/v1/voice_notes` +
    `?select=${columns}` +
    `&order=created_at.desc` +
    `&limit=1000`;

  try {
    const r = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'Supabase read failed', detail });
    }

    const rows = await r.json();
    return res.status(200).json({ count: rows.length, rows });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
