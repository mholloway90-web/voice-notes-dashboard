const SUPABASE_URL = 'https://ecjmqwdijgsycbqkfcog.supabase.co';

const RETURN_COLS = 'id,transcript,is_open_loop,loop_resolved,resolved_at';

export default async function handler(req, res) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server missing Supabase key' });
  }

  // apikey only. New-style sb_secret_ keys are rejected on Authorization.
  const headers = { apikey: key, 'Content-Type': 'application/json' };

  if (req.method === 'GET') {
    const id = parseInt(req.query.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Pass a numeric ?id=' });
    }
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_notes?id=eq.${id}&select=${RETURN_COLS}`,
      { headers }
    );
    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'No row with that id' });
    return res.status(200).json({ mode: 'inspect', row: rows[0] });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST to resolve' });
  }

  const id = parseInt(req.body && req.body.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Body must be {"id": <number>}' });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_notes?id=eq.${id}&select=${RETURN_COLS}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          loop_resolved: true,
          resolved_at: new Date().toISOString(),
        }),
      }
    );

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'Supabase write failed', detail });
    }

    const rows = await r.json();
    if (!rows.length) return res.status(404).json({ error: 'No row with that id' });

    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
