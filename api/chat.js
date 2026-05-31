// === SEMUA API KEYS ===
// Di Vercel, process.env otomatis terbaca tanpa perlu library 'dotenv'
const GEMINI_KEYS = [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean);
const GROQ_KEYS = [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2].filter(Boolean);

let geminiIndex = 0;
let groqIndex = 0;
let openrouterIndex = 0;

// Memory Chat Lokal
const conversations = new Map();

function getSystemPrompt() {
  return `Kamu adalah XREZZKY AI, asisten santai dan temen belanja di xrezzky official store ini.

Personality: Ramah, asik, helpful, natural seperti ngobrol sama temen.
Bahasa Indonesia sehari-hari, santai tapi sopan.

Tugas Utama:
- Bantu produk, stok, harga, rekomendasi.
- Cek status pesanan.
- Jelaskan kebijakan toko.

Aturan:
1. Fokus hanya ke bisnis toko ini.
2. Kalau ditanya hal di luar xrezzky official store, jawab santai: "Hehe, aku cuma ngerti soal xrezzky official store nih."

Jawab dengan natural dan langsung.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, sessionId = 'default' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // Memory Management
  if (!conversations.has(sessionId)) conversations.set(sessionId, []);
  let history = conversations.get(sessionId);
  history.push({ role: "user", content: message });

  if (history.length > 20) {
    history = history.slice(-20);
    conversations.set(sessionId, history);
  }

  let reply = "";

  // 1. Coba Gemini dulu (Paling bagus untuk Bahasa Indonesia)
  if (GEMINI_KEYS.length > 0) {
    try {
      const key = GEMINI_KEYS[geminiIndex % GEMINI_KEYS.length];
      geminiIndex++;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ 
              text: getSystemPrompt() + "\n\nRiwayat:\n" + 
                    history.map(m => `${m.role === "user" ? "User" : "XREZZ"}: ${m.content}`).join("\n") +
                    "\n\nXREZZ:" 
            }] }],
            generationConfig: { temperature: 0.75, maxOutputTokens: 700 }
          })
        }
      );

      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        reply = data.candidates[0].content.parts[0].text;
      }
    } catch (e) {
      console.log("Gemini gagal, mencoba Groq...");
    }
  }

  // 2. Fallback ke Groq (Super cepat)
  if (!reply && GROQ_KEYS.length > 0) {
    try {
      const key = GROQ_KEYS[groqIndex % GROQ_KEYS.length];
      groqIndex++;

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: getSystemPrompt() }, ...history],
          temperature: 0.75,
          max_tokens: 700
        })
      });

      const data = await response.json();
      reply = data.choices?.[0]?.message?.content;
    } catch (e) {
      console.log("Groq gagal, mencoba OpenRouter...");
    }
  }

  // 3. Last fallback ke OpenRouter
  if (!reply && OPENROUTER_KEYS.length > 0) {
    try {
      const key = OPENROUTER_KEYS[openrouterIndex % OPENROUTER_KEYS.length];
      openrouterIndex++;

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://xrezzky.com",
          "X-Title": "XREZZ AI"
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "system", content: getSystemPrompt() }, ...history]
        })
      });

      const data = await response.json();
      reply = data.choices?.[0]?.message?.content;
    } catch (e) {
      console.log("OpenRouter juga gagal");
    }
  }

  // Jika semua gagal
  if (!reply) {
    reply = "Maaf, semua provider sedang sibuk. Coba lagi sebentar ya.";
  }

  // Simpan jawaban ke memory
  history.push({ role: "assistant", content: reply });
  conversations.set(sessionId, history);

  res.status(200).json({ reply });
}
