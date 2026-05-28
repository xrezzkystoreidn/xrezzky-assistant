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

    const available = providers.filter(p => p.keys.length > 0);
    if (available.length === 0) return null;

    const provider = available[Math.floor(Math.random() * available.length)];
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
        } catch (e) {}
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
        throw new Error(`Groq error ${response.status}: ${err}`);
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
    // DEBUG ENDPOINT - GET /api/chat?action=debug
    // Akses dari browser buat cek semua env & provider
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

        // Test Gemini
        let geminiStatus = 'skipped';
        try {
            const key = process.env.GEMINI_API_KEY_1;
            if (key) {
                await callGemini(key, "Kamu asisten toko.", "Halo, tes koneksi. Balas singkat saja.");
                geminiStatus = 'ok';
            } else {
                geminiStatus = 'no_key';
            }
        } catch (e) {
            geminiStatus = `error: ${e.message}`;
        }

        // Test Groq
        let groqStatus = 'skipped';
        try {
            const key = process.env.GROQ_API_KEY_1;
            if (key) {
                await callGroq(key, "Kamu asisten toko.", "Halo, tes koneksi. Balas singkat saja.");
                groqStatus = 'ok';
            } else {
                groqStatus = 'no_key';
            }
        } catch (e) {
            groqStatus = `error: ${e.message}`;
        }

        // Test OpenRouter
        let openrouterStatus = 'skipped';
        try {
            const key = process.env.OPENROUTER_API_KEY_1;
            if (key) {
                await callOpenRouter(key, "Kamu asisten toko.", "Halo, tes koneksi. Balas singkat saja.");
                openrouterStatus = 'ok';
            } else {
                openrouterStatus = 'no_key';
            }
        } catch (e) {
            openrouterStatus = `error: ${e.message}`;
        }

        return res.status(200).json({
            env: envCheck,
            providers: { gemini: geminiStatus, groq: groqStatus, openrouter: openrouterStatus }
        });
    }

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

        // Chat utama — fallback otomatis antar provider
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

            // Coba semua provider secara berurutan sampai ada yang berhasil
            const providerOrder = ['gemini', 'groq', 'openrouter'];
            const providerKeys = {
                gemini: [process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2].filter(Boolean),
                groq: [process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2].filter(Boolean),
                openrouter: [process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2].filter(Boolean),
            };

            let aiResponse = null;
            let usedProvider = null;
            let lastError = null;

            for (const providerName of providerOrder) {
                const keys = providerKeys[providerName];
                if (keys.length === 0) continue;

                // Acak key dalam provider ini
                const key = keys[Math.floor(Math.random() * keys.length)];

                try {
                    if (providerName === 'gemini') {
                        aiResponse = await callGemini(key, systemPrompt, user_message, user_image);
                    } else if (providerName === 'groq') {
                        aiResponse = await callGroq(key, systemPrompt, user_message);
                    } else if (providerName === 'openrouter') {
                        aiResponse = await callOpenRouter(key, systemPrompt, user_message);
                    }
                    usedProvider = providerName;
                    break; // Berhasil, stop loop
                } catch (e) {
                    console.error(`[${providerName}] gagal:`, e.message);
                    lastError = e.message;
                    // Lanjut ke provider berikutnya
                }
            }

            if (!aiResponse) {
                return res.status(500).json({
                    response: "Semua provider AI sedang down bro, coba lagi bentar lagi ya.",
                    error: lastError
                });
            }

            return res.status(200).json({ response: aiResponse, provider: usedProvider });

        } catch (error) {
            console.error("Chat error:", error.message);
            return res.status(500).json({
                response: "Server error bro, coba lagi.",
                error: error.message
            });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
