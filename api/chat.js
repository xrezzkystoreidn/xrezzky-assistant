// Supabase di-lazy import biar tidak crash saat init
let supabaseModule = null;

async function getSupabase() {
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return null;
        if (!supabaseModule) {
            supabaseModule = await import('@supabase/supabase-js');
        }
        return supabaseModule.createClient(url, key);
    } catch (e) {
        console.error("Supabase error:", e.message);
        return null;
    }
}

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
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
        throw new Error(`Gemini ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

async function callGroq(apiKey, systemPrompt, userMessage) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage || "Halo" }
            ],
            max_tokens: 1024
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

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
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage || "Halo" }
            ],
            max_tokens: 1024
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query;

    // ==========================================
    // DEBUG
    // ==========================================
    if (req.method === 'GET' && action === 'debug') {
        const env = {
            SUPABASE_URL: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) : 'KOSONG',
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ada ✓' : 'KOSONG ✗',
            GEMINI_API_KEY_1: process.env.GEMINI_API_KEY_1 ? 'ada ✓' : 'KOSONG ✗',
            GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2 ? 'ada ✓' : 'KOSONG ✗',
            GROQ_API_KEY_1: process.env.GROQ_API_KEY_1 ? 'ada ✓' : 'KOSONG ✗',
            GROQ_API_KEY_2: process.env.GROQ_API_KEY_2 ? 'ada ✓' : 'KOSONG ✗',
            OPENROUTER_API_KEY_1: process.env.OPENROUTER_API_KEY_1 ? 'ada ✓' : 'KOSONG ✗',
            OPENROUTER_API_KEY_2: process.env.OPENROUTER_API_KEY_2 ? 'ada ✓' : 'KOSONG ✗',
        };

        const providers = {};

        try {
            const key = process.env.GEMINI_API_KEY_1;
            if (key) { await callGemini(key, "Kamu asisten.", "Balas: OK"); providers.gemini = '✓ OK'; }
            else providers.gemini = '✗ no_key';
        } catch (e) { providers.gemini = '✗ ' + e.message.slice(0, 250); }

        try {
            const key = process.env.GROQ_API_KEY_1;
            if (key) { await callGroq(key, "Kamu asisten.", "Balas: OK"); providers.groq = '✓ OK'; }
            else providers.groq = '✗ no_key';
        } catch (e) { providers.groq = '✗ ' + e.message.slice(0, 250); }

        try {
            const key = process.env.OPENROUTER_API_KEY_1;
            if (key) { await callOpenRouter(key, "Kamu asisten.", "Balas: OK"); providers.openrouter = '✓ OK'; }
            else providers.openrouter = '✗ no_key';
        } catch (e) { providers.openrouter = '✗ ' + e.message.slice(0, 250); }

        return res.status(200).json({ env, providers });
    }

    // ==========================================
    // GET — Ambil data info_toko
    // ==========================================
    if (req.method === 'GET') {
        const supabase = await getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia. Cek env SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY." });
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
            const supabase = await getSupabase();
            if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia." });
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

        // Chat utama
        try {
            const { user_message, user_image } = req.body;

            // Ambil knowledge — kalau Supabase gagal, tetap lanjut
            let knowledgeContext = "";
            try {
                const supabase = await getSupabase();
                if (supabase) {
                    const { data: infoToko } = await supabase.from('info_toko').select('content').limit(10);
                    if (infoToko && infoToko.length > 0) {
                        knowledgeContext = infoToko.map(i => i.content).join("\n");
                    }
                }
            } catch (e) {
                console.error("Supabase knowledge fetch gagal:", e.message);
            }

            const systemPrompt = `Kamu adalah XREZZ AI, asisten resmi XREZZKY OFFICIAL STORE.
Gunakan data resmi toko di bawah ini untuk menjawab pelanggan:
${knowledgeContext || "Nama Toko: XREZZKY OFFICIAL STORE. Melayani top up game dan kebutuhan gamers terpercaya."}
Aturan: Jawab santai ala anak muda/gamers, gunakan sebutan 'bro' atau 'kak'.`;

            // Fallback otomatis: Gemini → Groq → OpenRouter
            const providers = [
                { name: 'gemini', keys: [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean) },
                { name: 'groq', keys: [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean) },
                { name: 'openrouter', keys: [process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2].filter(Boolean) },
            ];

            let aiResponse = null;
            let usedProvider = null;
            let lastError = null;

            for (const p of providers) {
                if (p.keys.length === 0) continue;
                const key = p.keys[Math.floor(Math.random() * p.keys.length)];
                try {
                    if (p.name === 'gemini') aiResponse = await callGemini(key, systemPrompt, user_message, user_image);
                    else if (p.name === 'groq') aiResponse = await callGroq(key, systemPrompt, user_message);
                    else if (p.name === 'openrouter') aiResponse = await callOpenRouter(key, systemPrompt, user_message);
                    usedProvider = p.name;
                    break;
                } catch (e) {
                    console.error(`[${p.name}] error:`, e.message);
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
            console.error("Handler error:", error.message);
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
