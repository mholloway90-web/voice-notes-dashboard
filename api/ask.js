module.exports = async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "missing chat_id in URL" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const supabaseUrl = "https://ecjmqwdijgsycbqkfcog.supabase.co";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseKey) {
      return res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY env var not found" });
    }

    // Pull the most recent 200 notes with the columns useful for answering
    const cols = "id,created_at,work_or_personal,sub_or_person,job_name,trade,theme,entry_type,note_type,priority,action_required,is_open_loop,transcript,claude_response";
    const query = supabaseUrl + "/rest/v1/voice_notes?select=" + cols + "&order=created_at.desc&limit=200";

    const dbResp = await fetch(query, {
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey
      }
    });

    if (!dbResp.ok) {
      const errText = await dbResp.text();
      return res.status(500).json({ ok: false, stage: "supabase", status: dbResp.status, error: errText });
    }

    const notes = await dbResp.json();

    const msg = "ask found " + notes.length + " notes";
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });

    return res.status(200).json({ ok: true, count: notes.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
