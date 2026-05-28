import { createClient } from '@supabase/supabase-js';

// ==========================================
// SUPABASE
// ==========================================
function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
}

// ==========================================
// GEMINI — pakai fetch langsung (no SDK)
// ==========================================
async function callGemini(apiKey, systemPrompt, userMessage, userImage) {
    const parts = [];

    if (userImage && userImage.includes(",")) {
        try {
            const split = userImage.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            parts.push({ inline_data: { data: split[1], mime_type: mimeType } });
        } catch (e) {}
    }
    parts.push({ text: userMessage || "Halo" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts }]
        })
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

// ==========================================
// GROQ
// ==========================================
async function callGroq(apiKey, systemPrompt, userMessage) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "llama3-8b-8192",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage || "Halo" }
            ],
            max_tokens: 1024
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// ==========================================
// OPENROUTER
// ==========================================
async function callOpenRouter(apiKey, systemPrompt, userMessage) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://xrezzky-assistant.vercel.app",
            "X-Title": "XREZZKY OFFICIAL STORE"
        },
        body: JSON.stringify({
            model: "mistralai/mistral-7b-instruct:free",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage || "Halo" }
            ],
            max_tokens: 1024
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query;
    const supabase = getSupabase();

    // ==========================================
    // DEBUG — GET /api/chat?action=debug
    // ==========================================
    if (req.method === 'GET' && action === 'debug') {
        const envCheck = {
            supabase_url: !!process.env.SUPABASE_URL,
            supabase_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            gemini_key_1: !!process.env.GEMINI_API_KEY_1,
            gemini_key_2: !!process.env.GEMINI_API_KEY_2,
            groq_key_1: !!process.env.GROQ_API_KEY_1,
            groq_key_2: !!process.env.GROQ_API_KEY_2,
            openrouter_key_1: !!process.env.OPENROUTER_API_KEY_1,
            openrouter_key_2: !!process.env.OPENROUTER_API_KEY_2,
        };

        const results = {};

        try {
            const key = process.env.GEMINI_API_KEY_1;
            if (key) { await callGemini(key, "Kamu asisten.", "Tes. Balas: OK"); results.gemini = 'ok'; }
            else results.gemini = 'no_key';
        } catch (e) { results.gemini = `error: ${e.message.slice(0, 200)}`; }

        try {
            const key = process.env.GROQ_API_KEY_1;
            if (key) { await callGroq(key, "Kamu asisten.", "Tes. Balas: OK"); results.groq = 'ok'; }
            else results.groq = 'no_key';
        } catch (e) { results.groq = `error: ${e.message.slice(0, 200)}`; }

        try {
            const key = process.env.OPENROUTER_API_KEY_1;
            if (key) { await callOpenRouter(key, "Kamu asisten.", "Tes. Balas: OK"); results.openrouter = 'ok'; }
            else results.openrouter = 'no_key';
        } catch (e) { results.openrouter = `error: ${e.message.slice(0, 200)}`; }

        return res.status(200).json({ env: envCheck, providers: results });
    }

    // ==========================================
    // GET — Ambil data info_toko
    // ==========================================
    if (req.method === 'GET') {
        if (!supabase) return res.status(500).json({ error: "Koneksi Supabase gagal." });
        try {
            const { data, error } = await supabase
                .from('info_toko').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ data });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // ==========================================
    // POST
    // ==========================================
    if (req.method === 'POST') {

        if (action === 'save_context') {
            if (!supabase) return res.status(500).json({ error: "Supabase belum siap." });
            try {
                const { kategori, judul, content } = req.body;
                const { data, error } = await supabase
                    .from('info_toko').insert([{ kategori, judul, content }]);
                if (error) throw error;
                return res.status(200).json({ success: true, data });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // Chat utama — fallback otomatis
        try {
            const { user_message, user_image } = req.body;

            let knowledgeContext = "";
            if (supabase) {
                try {
                    const { data: infoToko } = await supabase.from('info_toko').select('content').limit(10);
                    if (infoToko) knowledgeContext = infoToko.map(i => i.content).join("\n");
                } catch (e) {}
            }

            const systemPrompt = `Kamu adalah XREZZ AI, asisten resmi XREZZKY OFFICIAL STORE.
Gunakan data resmi toko di bawah ini untuk menjawab pelanggan:
${knowledgeContext || "Nama Toko: XREZZKY OFFICIAL STORE. Melayani top up game dan kebutuhan gamers terpercaya."}
Aturan: Jawab santai ala anak muda/gamers, gunakan sebutan 'bro' atau 'kak'.`;

            const providerOrder = [
                { name: 'gemini', keys: [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean) },
                { name: 'groq', keys: [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean) },
                { name: 'openrouter', keys: [process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2].filter(Boolean) },
            ];

            let aiResponse = null;
            let usedProvider = null;
            let lastError = null;

            for (const p of providerOrder) {
                if (p.keys.length === 0) continue;
                const key = p.keys[Math.floor(Math.random() * p.keys.length)];
                try {
                    if (p.name === 'gemini') aiResponse = await callGemini(key, systemPrompt, user_message, user_image);
                    else if (p.name === 'groq') aiResponse = await callGroq(key, systemPrompt, user_message);
                    else if (p.name === 'openrouter') aiResponse = await callOpenRouter(key, systemPrompt, user_message);
                    usedProvider = p.name;
                    break;
                } catch (e) {
                    console.error(`[${p.name}] gagal:`, e.message);
                    lastError = e.message;
                }
            }

            if (!aiResponse) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar.",
                    error: lastError
                });
            }

            return res.status(200).json({ response: aiResponse, provider: usedProvider });

        } catch (error) {
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
