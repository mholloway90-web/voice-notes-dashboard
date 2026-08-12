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

// Legacy JWT service_role keys need Authorization: Bearer to get elevated
// privileges. Without it the request silently drops to the anon role, and
// RLS with zero policies returns an empty set with no error. New sb_secret_
// keys are the opposite: they are rejected on that header and go on apikey
// alone. Detecting the key type here means rotating the key needs no code change.
function supabaseHeaders(key) {
  const h = { apikey: key };
  if (!key.startsWith("sb_")) {
    h.Authorization = "Bearer " + key;
  }
  return h;
}

module.exports = async (req, res) => {
  try {
    // Secret gate: every request must carry the matching header
    const expected = process.env.ASK_SHARED_SECRET;
    const provided = req.headers["x-ask-secret"];
    if (!expected || provided !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const chatId = req.query.chat_id;
    const question = req.query.q;
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "missing chat_id in URL" });
    }
    if (!question) {
      return res.status(400).json({ ok: false, error: "missing q (question) in URL" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
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
    const cols = "id,created_at,work_or_personal,sub_or_person,job_name,trade,theme,entry_type,note_type,priority,action_required,is_open_loop,loop_resolved,resolved_at,transcript,claude_response";
    const query = supabaseUrl + "/rest/v1/voice_notes?select=" + cols + "&order=created_at.desc&limit=1000";
    const dbResp = await fetch(query, {
      headers: supabaseHeaders(supabaseKey)
    });
    if (!dbResp.ok) {
      const errText = await dbResp.text();
      return res.status(500).json({ ok: false, stage: "supabase", status: dbResp.status, error: errText });
    }
    const notes = await dbResp.json();

    // Zero rows means the key was not accepted as service_role. Fail loudly
    // rather than letting Claude answer confidently from an empty table.
    if (!Array.isArray(notes) || notes.length === 0) {
      await sendChunks(token, chatId, "Could not read your notes. The database returned zero rows, which usually means the Supabase key is not being accepted as service_role. Nothing was answered from real data.");
      return res.status(500).json({ ok: false, stage: "supabase", error: "zero rows returned" });
    }

    // Keep the payload sane as the table grows.
    const MAX_CHARS = 400000;
    let running = 0;
    const trimmed = [];
    for (const n of notes) {
      running += 860;
      if (running > MAX_CHARS) break;
      trimmed.push(n);
    }

    // 2. Build a compact context, truncating any giant transcript
    const context = trimmed.map(function (n) {
      var t = n.loop_resolved === true
        ? (n.transcript || "").slice(0, 200)
        : (n.transcript || "").slice(0, 2000);
      return [
        "id:" + n.id,
        "date:" + n.created_at,
        "job:" + (n.job_name || ""),
        "trade:" + (n.trade || ""),
        "theme:" + (n.theme || ""),
        "type:" + (n.entry_type || n.note_type || ""),
        "priority:" + (n.priority || ""),
        "open_loop:" + n.is_open_loop,
        "resolved:" + (n.loop_resolved === true ? "YES closed " + (n.resolved_at || "") : "no"),
        "action:" + (n.action_required || ""),
        "transcript:" + t,
        "summary:" + (n.claude_response || "")
      ].join(" | ");
    }).join("\n\n");

    const systemPrompt = "You answer questions from Mike's field voice notes. Use only the notes provided. Each note has open_loop and resolved fields. A note is only an active open loop if open_loop:true AND resolved:no. If a note shows resolved:YES, it is DONE and must never be listed as open, outstanding, or needing action, even if its text describes unfinished work. Never invent an id.\n\nJOB NAMES: the job field is already normalized and correct. Mike's jobs are: Wind River, Colina, Taft, Arizona, Admiralty, Allbrook, Alexandri, Avenida Marbella, Helen, Revillo. 'General' means no specific job. Treat each value as its own job and NEVER merge two different job names, however similar they sound. The ONLY exception: two notes name two jobs at once. A note tagged 'Allbrook / Taft' counts for BOTH Allbrook and Taft. A note tagged 'Taft and Admiralty' counts for BOTH Taft and Admiralty. No other note belongs to more than one job.\n\nBe concise and practical, like a reply read on a phone at a job site. If the notes do not cover the question, say so plainly. When useful, cite the note date.";
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

    return res.status(200).json({ ok: true, parts: parts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
