module.exports = async (req, res) => {
  try {
    const chatId = req.query.chat_id;
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "missing chat_id in URL" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN env var not found" });
    }

    const tg = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "ask endpoint is alive" })
    });
    const tgResult = await tg.json();

    return res.status(200).json({ ok: true, telegram: tgResult });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
};
