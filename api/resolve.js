// /api/resolve.js
// Closes an open loop: sets loop_resolved = true and stamps resolved_at.
// Triggered by Make.com when a Telegram message starts with /resolve.

export default async function handler(req, res) {
  const SUPABASE_URL = 'https://ecjmqwdijgsycbqkfcog.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const SECRET = process.env.ASK_SHARED_SECRET;

  // Health check: tapping the URL in a browser hits this. Mutates nothing.
  if (req.method === 'GET') {
    return res.status(200).send('resolve endpoint alive');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Auth: shared secret must arrive in the header, never the URL.
  if (!SECRET || req.headers['x-ask-secret'] !== SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Parse the body (Vercel usually parses JSON; guard just in case).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body) body = {};
  const chatId = body.chat_id;
  const text = (body.text || '').toString();

  // Helper: reply into the Telegram chat.
  async function tg(message) {
    if (!chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message })
      });
    } catch (e) { /* ignore reply failures */ }
  }

  // Pull the id out of the message. Handles /resolve 187 and /resolve@Bot 187.
  const match = text.match(/\/resolve(?:@\S+)?\s+(\d+)/i);
  if (!match) {
    await tg('Send it like /resolve 187');
    return res.status(200).json({ ok: false, reason: 'no_id' });
  }
  const id = parseInt(match[1], 10);

  // Look up the row.
  const lookupUrl = `${SUPABASE_URL}/rest/v1/voice_notes?id=eq.${id}` +
    `&select=id,job_name,note_type,priority,is_open_loop,loop_resolved,resolved_at`;
  const lookupResp = await fetch(lookupUrl, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const rows = await lookupResp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    await tg(`No entry #${id} found.`);
    return res.status(200).json({ ok: false, reason: 'not_found' });
  }
  const row = rows[0];

  // First line of job_name is the clean job label, even though the column is polluted.
  const jobLabel = (row.job_name || 'Unknown').toString().split('\n')[0].trim();
  const priority = (row.priority || '').toString().trim();
  const tag = priority ? `${jobLabel}, ${priority}` : jobLabel;

  // Already closed? Leave the original timestamp alone.
  if (row.loop_resolved === true) {
    const when = row.resolved_at ? row.resolved_at.toString().slice(0, 10) : 'earlier';
    await tg(`Entry #${id} (${tag}) was already closed on ${when}. Left it as is.`);
    return res.status(200).json({ ok: true, already: true });
  }

  // Do the write.
  const nowIso = new Date().toISOString();
  const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/voice_notes?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({ loop_resolved: true, resolved_at: nowIso })
  });

  if (!patchResp.ok) {
    const errText = await patchResp.text();
    await tg(`Could not close #${id}. Database said: ${errText.slice(0, 200)}`);
    return res.status(200).json({ ok: false, reason: 'update_failed' });
  }

  await tg(`✅ Closed #${id} (${tag}). Marked resolved just now.`);
  return res.status(200).json({ ok: true, id });
}
