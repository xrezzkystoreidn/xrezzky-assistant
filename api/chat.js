import { createClient } from '@supabase/supabase-js';

// ==========================================
// SUPABASE
// ==========================================
async function getSupabase() {
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return null;
        new URL(url);
        return createClient(url, key);
    } catch (e) {
        console.error("Supabase init error:", e.message);
        return null;
    }
}

// ==========================================
// GEMINI — fetch langsung
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

// ==========================================
// GROQ — teks only
// ==========================================
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

// ==========================================
// OPENROUTER — support teks & gambar
// ==========================================
async function callOpenRouter(apiKey, systemPrompt, userMessage, userImage) {
    let userContent;

    if (userImage && userImage.includes(",")) {
        try {
            const split = userImage.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            userContent = [
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${split[1]}` } },
                { type: "text", text: userMessage || "Lihat gambar ini" }
            ];
        } catch (e) {
            userContent = userMessage || "Halo";
        }
    } else {
        userContent = userMessage || "Halo";
    }

    // Kalau ada gambar pakai model vision, kalau tidak pakai model gratis
    const model = (userImage && userImage.includes(","))
        ? "google/gemini-2.0-flash-001"
        : "meta-llama/llama-3.1-8b-instruct:free";

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://xrezzky-assistant.vercel.app",
            "X-Title": "XREZZKY OFFICIAL STORE"
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
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

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query;

    // ==========================================
    // GET — ambil data / debug
    // ==========================================
    if (req.method === 'GET') {
        // Debug endpoint
        if (action === 'debug') {
            const env = {
                SUPABASE_URL: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) : 'KOSONG',
                SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ada ✓' : 'KOSONG ✗',
                GEMINI: [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
                GROQ: [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
                OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
            };
            const providers = {};
            try {
                const key = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).find(Boolean);
                if (key) { await callGemini(key, "Kamu asisten.", "Balas: OK"); providers.gemini = 'OK ✓'; }
                else providers.gemini = 'no_key';
            } catch (e) { providers.gemini = '✗ ' + e.message.slice(0,150); }
            try {
                const key = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).find(Boolean);
                if (key) { await callGroq(key, "Kamu asisten.", "Balas: OK"); providers.groq = 'OK ✓'; }
                else providers.groq = 'no_key';
            } catch (e) { providers.groq = '✗ ' + e.message.slice(0,150); }
            try {
                const key = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).find(Boolean);
                if (key) { await callOpenRouter(key, "Kamu asisten.", "Balas: OK", null); providers.openrouter = 'OK ✓'; }
                else providers.openrouter = 'no_key';
            } catch (e) { providers.openrouter = '✗ ' + e.message.slice(0,150); }
            return res.status(200).json({ env, providers });
        }

        // Get prompt untuk admin
        if (action === 'get_prompt') {
            const supabase = await getSupabase();
            if (!supabase) return res.status(200).json({ prompt: null });
            try {
                const { data } = await supabase.from('ai_config').select('value').eq('key', 'system_prompt').single();
                return res.status(200).json({ prompt: data ? data.value : null });
            } catch(e) {
                return res.status(200).json({ prompt: null });
            }
        }

        // Ambil knowledge dari Supabase
        const supabase = await getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia. Cek env SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY." });
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

        // Simpan knowledge
        if (action === 'save_context') {
            const supabase = await getSupabase();
            if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia." });
            try {
                const { kategori, judul, content } = req.body;
                const { data, error } = await supabase.from('info_toko').insert([{ kategori, judul, content }]);
                if (error) throw error;
                return res.status(200).json({ success: true, data });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // Hapus knowledge
        if (action === 'delete_context') {
            const supabase = await getSupabase();
            if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia." });
            try {
                const { id } = req.body;
                const { error } = await supabase.from('info_toko').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // Simpan system prompt
        if (action === 'save_prompt') {
            const supabase = await getSupabase();
            if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia." });
            try {
                const { prompt } = req.body;
                const { error } = await supabase.from('ai_config')
                    .upsert({ key: 'system_prompt', value: prompt }, { onConflict: 'key' });
                if (error) throw error;
                return res.status(200).json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // ==========================================
        // CHAT UTAMA
        // ==========================================
        try {
            const { user_message, user_image } = req.body;
            const hasImage = !!(user_image && user_image.includes(","));

            // Ambil knowledge + system prompt dari Supabase
            let knowledgeContext = "";
            let customPrompt = null;
            try {
                const supabase = await getSupabase();
                if (supabase) {
                    const [knowledgeRes, promptRes] = await Promise.all([
                        supabase.from('info_toko').select('judul, content').limit(20),
                        supabase.from('ai_config').select('value').eq('key', 'system_prompt').single()
                    ]);
                    if (knowledgeRes.data && knowledgeRes.data.length > 0) {
                        knowledgeContext = knowledgeRes.data.map(i => `${i.judul}: ${i.content}`).join("\n");
                    }
                    if (promptRes.data && promptRes.data.value) {
                        customPrompt = promptRes.data.value;
                    }
                }
            } catch (e) {
                console.error("Supabase fetch error:", e.message);
            }

            // System prompt: dari Supabase kalau ada, kalau tidak pakai fallback minimal
            const systemPrompt = customPrompt
                ? customPrompt.replace('{knowledge}', knowledgeContext || '-')
                : `Kamu adalah XREZZ AI, asisten XREZZKY OFFICIAL STORE.\n${knowledgeContext ? 'Data toko:\n' + knowledgeContext : ''}\nJawab santai, sebut user dengan bro/kak.`;

            // Semua key per provider
            const geminiKeys = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).filter(Boolean);
            const groqKeys   = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).filter(Boolean);
            const orKeys     = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean);

            // Acak key dalam provider
            const pick = arr => arr[Math.floor(Math.random() * arr.length)];

            // Fallback order:
            // Ada gambar  → Gemini(semua key) → OpenRouter vision → gagal
            // Teks biasa  → Gemini → Groq → OpenRouter → gagal
            const providerQueue = hasImage
                ? [
                    ...geminiKeys.map(k => ({ name: 'gemini', key: k })),
                    ...orKeys.map(k => ({ name: 'openrouter', key: k }))
                  ]
                : [
                    { name: 'gemini', key: pick(geminiKeys) },
                    { name: 'groq', key: pick(groqKeys) },
                    { name: 'openrouter', key: pick(orKeys) }
                  ].filter(p => p.key);

            let aiResponse = null;
            let usedProvider = null;
            let lastError = null;

            for (const p of providerQueue) {
                if (!p.key) continue;
                try {
                    if (p.name === 'gemini') {
                        aiResponse = await callGemini(p.key, systemPrompt, user_message, user_image);
                    } else if (p.name === 'groq') {
                        aiResponse = await callGroq(p.key, systemPrompt, user_message);
                    } else if (p.name === 'openrouter') {
                        aiResponse = await callOpenRouter(p.key, systemPrompt, user_message, user_image);
                    }
                    usedProvider = p.name;
                    break;
                } catch (e) {
                    console.error(`[${p.name}] key error:`, e.message);
                    lastError = e.message;
                    // Lanjut ke key/provider berikutnya
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
