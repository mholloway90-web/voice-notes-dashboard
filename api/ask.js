function splitMessage(text, maxLen) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

async function sendChunks(token, chatId, text) {
  const chunks = splitMessage(text, 3900);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? "(" + (i + 1) + "/" + chunks.length + ")\n" : "";
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: prefix + chunks[i] })
    });
  }
  return chunks.length;
}

module.exports = async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    const question = req.query.q;
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "missing chat_id in URL" });
    }
    if (!question) {
      return res.status(400).json({ ok: false, error: "missing q (question) in URL" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;

    // Temporary test hook for chunking, removed at lockdown
    if (question === "__chunktest__") {
      let longText = "";
      for (let i = 1; i <= 200; i++) {
        longText += "Line " + i + ": test line to exercise Telegram chunking.\n";
      }
      const parts = await sendChunks(token, chatId, longText);
      return res.status(200).json({ ok: true, test: true, totalChars: longText.length, parts: parts });
    }

    const supabaseUrl = "https://ecjmqwdijgsycbqkfcog.supabase.co";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!supabaseKey) {
      return res.status(500).json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY env var not found" });
    }
    if (!anthropicKey) {
      return res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY env var not found" });
    }

    // 1. Pull the most recent 200 notes
    const cols = "id,created_at,work_or_personal,sub_or_person,job_name,trade,theme,entry_type,note_type,priority,action_required,is_open_loop,transcript,claude_response";
    const query = supabaseUrl + "/rest/v1/voice_notes?select=" + cols + "&order=created_at.desc&limit=200";
    const dbResp = await fetch(query, {
      headers: { apikey: supabaseKey, Authorization: "Bearer " + supabaseKey }
    });
    if (!dbResp.ok) {
      const errText = await dbResp.text();
      return res.status(500).json({ ok: false, stage: "supabase", status: dbResp.status, error: errText });
    }
    const notes = await dbResp.json();

    // 2. Build a compact context, truncating any giant transcript
    const context = notes.map(function (n) {
      var t = (n.transcript || "").slice(0, 2000);
      return [
        "id:" + n.id,
        "date:" + n.created_at,
        "job:" + (n.job_name || ""),
        "trade:" + (n.trade || ""),
        "theme:" + (n.theme || ""),
        "type:" + (n.entry_type || n.note_type || ""),
        "priority:" + (n.priority || ""),
        "open_loop:" + n.is_open_loop,
        "action:" + (n.action_required || ""),
        "transcript:" + t,
        "summary:" + (n.claude_response || "")
      ].join(" | ");
    }).join("\n\n");

    const systemPrompt = "You answer questions from Mike's field voice notes. Use only the notes provided. Be concise and practical, like a reply read on a phone at a job site. If the notes do not cover the question, say so plainly. When useful, cite the note date.";
    const userPrompt = "Question: " + question + "\n\nNotes:\n" + context;

    // 3. Ask Claude
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return res.status(500).json({ ok: false, stage: "anthropic", status: aiResp.status, error: errText });
    }
    const aiData = await aiResp.json();
    const answer = (aiData.content || [])
      .filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; })
      .join("\n")
      .trim() || "No answer generated.";

    // 4. Reply in Telegram, splitting long answers across messages
    const parts = await sendChunks(token, chatId, answer);

    return res.status(200).json({ ok: true, parts: parts, answer: answer });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
