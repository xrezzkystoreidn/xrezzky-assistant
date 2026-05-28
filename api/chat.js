import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
// LOAD BALANCER - 3 Provider, masing-masing 2 key
// Urutan fallback: Gemini → Groq → OpenRouter
// ==========================================
function getProviderConfig() {
    const providers = [
        {
            name: 'gemini',
            keys: [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean)
        },
        {
            name: 'groq',
            keys: [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean)
        },
        {
            name: 'openrouter',
            keys: [process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2].filter(Boolean)
        }
    ];

    // Filter provider yang punya key
    const available = providers.filter(p => p.keys.length > 0);
    if (available.length === 0) return null;

    // Pilih provider secara random (load balance antar provider)
    const provider = available[Math.floor(Math.random() * available.length)];
    // Pilih key secara random dari provider tersebut
    const key = provider.keys[Math.floor(Math.random() * provider.keys.length)];

    return { provider: provider.name, key };
}

// ==========================================
// CALLER PER PROVIDER
// ==========================================
async function callGemini(apiKey, systemPrompt, userMessage, userImage) {
    const ai = new GoogleGenerativeAI(apiKey);
    const model = ai.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: systemPrompt
    });

    const parts = [];
    if (userImage && userImage.includes(",")) {
        try {
            const split = userImage.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            parts.push({ inlineData: { data: split[1], mimeType } });
        } catch (e) {
            console.error("Gagal parse gambar Gemini:", e);
        }
    }
    parts.push({ text: userMessage || "Halo" });

    const result = await model.generateContent({
        contents: [{ role: "user", parts }]
    });
    return result.response.text();
}

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
        throw new Error(`Groq error: ${err}`);
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
        throw new Error(`OpenRouter error: ${err}`);
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
    // GET — Ambil data info_toko
    // ==========================================
    if (req.method === 'GET' || action === 'get_context') {
        if (!supabase) return res.status(500).json({ error: "Koneksi Supabase gagal. Cek Env Vercel." });
        try {
            const { data, error } = await supabase
                .from('info_toko')
                .select('*')
                .order('created_at', { ascending: false });
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

        // Admin: simpan konteks baru
        if (action === 'save_context') {
            if (!supabase) return res.status(500).json({ error: "Supabase belum siap." });
            try {
                const { kategori, judul, content } = req.body;
                const { data, error } = await supabase
                    .from('info_toko')
                    .insert([{ kategori, judul, content }]);
                if (error) throw error;
                return res.status(200).json({ success: true, data });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // Chat utama
        try {
            const { user_message, user_image } = req.body;

            // Ambil knowledge dari Supabase
            let knowledgeContext = "";
            if (supabase) {
                try {
                    const { data: infoToko } = await supabase.from('info_toko').select('content').limit(10);
                    if (infoToko) knowledgeContext = infoToko.map(i => i.content).join("\n");
                } catch (e) {
                    console.error("Gagal baca database:", e);
                }
            }

            const systemPrompt = `Kamu adalah XREZZ AI, asisten resmi XREZZKY OFFICIAL STORE.
Gunakan data resmi toko di bawah ini untuk menjawab pelanggan:
${knowledgeContext || "Nama Toko: XREZZKY OFFICIAL STORE. Melayani top up game dan kebutuhan gamers terpercaya."}

Aturan: Jawab santai ala anak muda/gamers, gunakan sebutan 'bro' atau 'kak'.`;

            // Pilih provider & key
            const config = getProviderConfig();
            if (!config) {
                return res.status(500).json({ response: "Error: Tidak ada API Key yang tersedia di environment." });
            }

            console.log(`[AI] Menggunakan provider: ${config.provider}`);

            let aiResponse = "";

            if (config.provider === 'gemini') {
                aiResponse = await callGemini(config.key, systemPrompt, user_message, user_image);
            } else if (config.provider === 'groq') {
                aiResponse = await callGroq(config.key, systemPrompt, user_message);
            } else if (config.provider === 'openrouter') {
                aiResponse = await callOpenRouter(config.key, systemPrompt, user_message);
            }

            return res.status(200).json({ response: aiResponse, provider: config.provider });

        } catch (error) {
            console.error("Chat error:", error.message);
            return res.status(500).json({
                response: "Server sedang sibuk, coba kirim chat lagi bro.",
                error: error.message
            });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
