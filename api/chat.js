// Supabase via REST API langsung - hindari DEP0169 dari SDK

// ==========================================
// SUPABASE
// ==========================================
// Supabase REST helper - tidak pakai SDK sama sekali, hindari DEP0169
function sbHeaders() {
    return {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        "Authorization": "Bearer " + (process.env.SUPABASE_SERVICE_ROLE_KEY || ""),
        "Prefer": "return=representation"
    };
}

function sbUrl(table, query) {
    const base = process.env.SUPABASE_URL;
    if (!base) return null;
    return base + "/rest/v1/" + table + (query ? "?" + query : "");
}

async function sbSelect(table, query) {
    const url = sbUrl(table, query);
    if (!url) return { data: null, error: "No SUPABASE_URL" };
    try {
        const res = await fetch(url, { headers: { ...sbHeaders(), "Prefer": "return=representation" } });
        if (!res.ok) throw new Error(await res.text());
        return { data: await res.json(), error: null };
    } catch(e) { return { data: null, error: e.message }; }
}

async function sbInsert(table, body) {
    const url = sbUrl(table);
    if (!url) return { data: null, error: "No SUPABASE_URL" };
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: sbHeaders(),
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(await res.text());
        return { data: await res.json(), error: null };
    } catch(e) { return { data: null, error: e.message }; }
}

async function sbDelete(table, id) {
    const url = sbUrl(table, "id=eq." + id);
    if (!url) return { error: "No SUPABASE_URL" };
    try {
        const res = await fetch(url, { method: "DELETE", headers: sbHeaders() });
        if (!res.ok) throw new Error(await res.text());
        return { error: null };
    } catch(e) { return { error: e.message }; }
}

async function sbUpsert(table, body, onConflict) {
    const url = sbUrl(table) + "?on_conflict=" + onConflict;
    if (!url) return { error: "No SUPABASE_URL" };
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(await res.text());
        return { error: null };
    } catch(e) { return { error: e.message }; }
}

// getSupabase tidak dipakai lagi tapi keep untuk kompatibilitas
async function getSupabase() { return true; }

// ==========================================
// REALTIME CONTEXT — waktu, tanggal, info terkini
// ==========================================
function getRealtimeContext() {
    const now = new Date();

    const wibOffset = 7 * 60;
    const wibNow = new Date(now.getTime() + (wibOffset - now.getTimezoneOffset()) * 60000);

    const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

    const hari = days[wibNow.getDay()];
    const tgl = wibNow.getDate();
    const bln = months[wibNow.getMonth()];
    const thn = wibNow.getFullYear();
    const jam = String(wibNow.getHours()).padStart(2,'0');
    const mnt = String(wibNow.getMinutes()).padStart(2,'0');
    const dtk = String(wibNow.getSeconds()).padStart(2,'0');

    let waktuHari = '';
    const h = wibNow.getHours();
    if (h >= 4 && h < 11) waktuHari = 'pagi';
    else if (h >= 11 && h < 15) waktuHari = 'siang';
    else if (h >= 15 && h < 18) waktuHari = 'sore';
    else waktuHari = 'malam';

    return `
=== INFORMASI REALTIME (DIPERBARUI SETIAP REQUEST) ===
Waktu sekarang  : ${jam}:${mnt}:${dtk} WIB
Hari ini        : ${hari}, ${tgl} ${bln} ${thn}
Waktu hari      : ${waktuHari}
Timestamp UTC   : ${now.toISOString()}
=======================================================
PENTING: Kamu TAHU waktu dan tanggal di atas secara REAL-TIME.
Kalau ditanya "jam berapa?", "hari apa?", "tanggal berapa?" — jawab berdasarkan data di atas.
Jangan pernah bilang tidak tahu waktu atau tanggal.
=======================================================`;
}

// ==========================================
// PROVIDER HEALTH TRACKER — auto cooldown kalau 429
// ==========================================
const providerHealth = {
    gemini:     { failCount: 0, coolUntil: 0 },
    groq:       { failCount: 0, coolUntil: 0 },
    openrouter: { failCount: 0, coolUntil: 0 },
};

function markFail(name) {
    const h = providerHealth[name];
    h.failCount++;
    // Cooldown: 2 menit per fail, max 10 menit
    const coolMs = Math.min(h.failCount * 2 * 60 * 1000, 10 * 60 * 1000);
    h.coolUntil = Date.now() + coolMs;
    console.error(`[${name}] fail #${h.failCount}, cooldown ${coolMs/1000}s`);
}

function markSuccess(name) {
    providerHealth[name].failCount = 0;
    providerHealth[name].coolUntil = 0;
}

function isCooling(name) {
    return Date.now() < providerHealth[name].coolUntil;
}

// ==========================================
// GEMINI 2.0 FLASH (LATEST) — fetch langsung
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

    // Pakai gemini-2.0-flash — model terbaru & paling cepat
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts }],
            generationConfig: {
                temperature: 0.7,
                topP: 0.9,
                maxOutputTokens: 2048
            }
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
// GROQ — llama-3.3-70b (model terbaru & terkuat)
// ==========================================
async function callGroq(apiKey, systemPrompt, userMessage) {
    // Daftar model Groq - dicoba berurutan kalau 429
    const groqModels = [
        "gemma2-9b-it",               // Google model, jarang restricted
        "gemma-7b-it",                // Google model alternatif
        "mixtral-8x7b-32768",         // Mistral, stabil
        "llama-3.1-8b-instant",       // llama cepat
        "llama3-8b-8192",             // llama classic
    ];

    let lastErr = null;
    for (const model of groqModels) {
        try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userMessage || "Halo" }
                    ],
                    max_tokens: 2048,
                    temperature: 0.7
                })
            });
            if (response.status === 429) {
                lastErr = new Error(`Groq ${model} 429`);
                continue; // coba model berikutnya
            }
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Groq ${model} ${response.status}: ${err}`);
            }
            const data = await response.json();
            return data.choices[0].message.content;
        } catch(e) {
            if (e.message.includes('429')) { lastErr = e; continue; }
            throw e;
        }
    }
    throw lastErr || new Error('Semua model Groq 429');
}

// ==========================================
// OPENROUTER — support teks & vision
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

    // Model list untuk teks (dicoba berurutan kalau 429)
    const textModels = [
        "google/gemma-2-9b-it:free",
        "mistralai/mistral-7b-instruct:free",
        "qwen/qwen2.5-7b-instruct:free",
        "microsoft/phi-3-mini-128k-instruct:free",
        "meta-llama/llama-3.2-3b-instruct:free",
    ];
    const visionModel = "google/gemini-2.0-flash-001";
    const model = (userImage && userImage.includes(",")) ? visionModel : textModels[0];

    // Kalau vision, langsung pakai model vision
    // Kalau teks, coba semua textModels sampai ada yang berhasil
    const modelsToTry = (userImage && userImage.includes(",")) ? [visionModel] : textModels;

    let lastErr2 = null;
    for (const m of modelsToTry) {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                    "HTTP-Referer": "https://xrezzky-assistant.vercel.app",
                    "X-Title": "XREZZKY OFFICIAL STORE"
                },
                body: JSON.stringify({
                    model: m,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userContent }
                    ],
                    max_tokens: 2048,
                    temperature: 0.7
                })
            });
            if (response.status === 429) {
                lastErr2 = new Error(`OpenRouter ${m} 429`);
                continue;
            }
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`OpenRouter ${m} ${response.status}: ${err}`);
            }
            const data = await response.json();
            return data.choices[0].message.content;
        } catch(e) {
            if (e.message.includes('429')) { lastErr2 = e; continue; }
            throw e;
        }
    }
    throw lastErr2 || new Error('Semua model OpenRouter 429');
}

// ==========================================
// HUGGINGFACE — emergency fallback gratis, tidak butuh key khusus
// ==========================================
async function callHuggingFace(userMessage, systemPrompt) {
    // Pakai model gratis HuggingFace Inference API
    const models = [
        "mistralai/Mistral-7B-Instruct-v0.3",
        "HuggingFaceH4/zephyr-7b-beta",
    ];

    const hfKey = process.env.HF_API_KEY; // opsional, kalau kosong tetap coba

    for (const model of models) {
        try {
            const prompt = "<s>[INST] " + systemPrompt + "\n\n" + userMessage + " [/INST]";
            const headers = { "Content-Type": "application/json" };
            if (hfKey) headers["Authorization"] = "Bearer " + hfKey;

            const apiUrl = "https://api-inference.huggingface.co/models/" + model;
            const response = await fetch(apiUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: { max_new_tokens: 512, temperature: 0.7, return_full_text: false }
                })
            });
            if (!response.ok) continue;
            const data = await response.json();
            if (Array.isArray(data) && data[0] && data[0].generated_text) {
                return data[0].generated_text.trim();
            }
        } catch(e) { continue; }
    }
    throw new Error("HuggingFace semua model gagal");
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
    // GET
    // ==========================================
    if (req.method === 'GET') {

        if (action === 'debug') {
            const env = {
                SUPABASE_URL: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0,40) : 'KOSONG',
                SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ada ✓' : 'KOSONG ✗',
                GEMINI: [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`] ? `key${i}:✓` : `key${i}:✗`),
                GROQ: [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`] ? `key${i}:✓` : `key${i}:✗`),
                OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:✓` : `key${i}:✗`),
                REALTIME: getRealtimeContext().trim().split('\n').slice(1,5).join(' | ')
            };
            const providers = {};
            try {
                const key = [1,2,3,4,5].map(i=>process.env[`GEMINI_API_KEY_${i}`]).find(Boolean);
                if (key) { await callGemini(key, "Asisten.", "Balas OK saja"); providers.gemini = 'OK ✓'; }
                else providers.gemini = 'no_key';
            } catch(e) { providers.gemini = '✗ '+e.message.slice(0,150); }
            try {
                const key = [1,2,3,4,5].map(i=>process.env[`GROQ_API_KEY_${i}`]).find(Boolean);
                if (key) { await callGroq(key, "Asisten.", "Balas OK saja"); providers.groq = 'OK ✓'; }
                else providers.groq = 'no_key';
            } catch(e) { providers.groq = '✗ '+e.message.slice(0,150); }
            try {
                const key = [1,2,3,4,5].map(i=>process.env[`OPENROUTER_API_KEY_${i}`]).find(Boolean);
                if (key) { await callOpenRouter(key, "Asisten.", "Balas OK saja", null); providers.openrouter = 'OK ✓'; }
                else providers.openrouter = 'no_key';
            } catch(e) { providers.openrouter = '✗ '+e.message.slice(0,150); }
            return res.status(200).json({ env, providers });
        }

        if (action === 'get_prompt') {
            const { data } = await sbSelect('ai_config', 'key=eq.system_prompt&select=value');
            const prompt = (data && data[0]) ? data[0].value : null;
            return res.status(200).json({ prompt });
        }

        // Ambil knowledge
        const { data, error } = await sbSelect('knowledge_base', 'order=created_at.desc');
        if (error) return res.status(500).json({ error });
        return res.status(200).json({ data });
    }

    // ==========================================
    // POST
    // ==========================================
    if (req.method === 'POST') {

        if (action === 'save_context') {
            const { kategori, judul, content: kContent } = req.body;
            const { error: insErr } = await sbInsert('knowledge_base', { kategori, judul, content: kContent });
            if (insErr) return res.status(500).json({ error: insErr });
            return res.status(200).json({ success: true });
        }

        if (action === 'delete_context') {
            const { id } = req.body;
            const { error: delErr } = await sbDelete('knowledge_base', id);
            if (delErr) return res.status(500).json({ error: delErr });
            return res.status(200).json({ success: true });
        }

        if (action === 'save_prompt') {
            const { prompt } = req.body;
            const { error: upsErr } = await sbUpsert('ai_config', { key: 'system_prompt', value: prompt }, 'key');
            if (upsErr) return res.status(500).json({ error: upsErr });
            return res.status(200).json({ success: true });
        }

        // ==========================================
        // CHAT UTAMA
        // ==========================================
        try {
            const { user_message, user_image } = req.body;
            const hasImage = !!(user_image && user_image.includes(","));

            // Ambil knowledge + system prompt dari Supabase secara paralel
            let knowledgeContext = "";
            let customPrompt = null;
            try {
                const [knowledgeRes, promptRes] = await Promise.all([
                    sbSelect('knowledge_base', 'select=judul,content&limit=20'),
                    sbSelect('ai_config', 'key=eq.system_prompt&select=value')
                ]);
                if (knowledgeRes.data && knowledgeRes.data.length > 0) {
                    knowledgeContext = knowledgeRes.data
                        .map(i => "[" + i.judul + "]: " + i.content)
                        .join("\n");
                }
                if (promptRes.data && promptRes.data[0] && promptRes.data[0].value) {
                    customPrompt = promptRes.data[0].value;
                }
            } catch(e) {
                console.error("Supabase fetch:", e.message);
            }

            // Realtime context — waktu & tanggal aktual
            const realtimeCtx = getRealtimeContext();

            // Build system prompt final
            const defaultPrompt = `Kamu adalah XREZZ AI, asisten cerdas XREZZKY OFFICIAL STORE.

DATA TOKO:
{knowledge}

KARAKTER: Santai, gaul, pakai 'bro' atau 'kak'. Helpful dan to the point.`;

            const promptTemplate = customPrompt || defaultPrompt;
            const knowledgePart = knowledgeContext || "Nama Toko: XREZZKY OFFICIAL STORE. Melayani top up game dan kebutuhan gamers terpercaya.";

            // Gabungkan: system prompt + knowledge + realtime context
            const systemPrompt = promptTemplate.replace('{knowledge}', knowledgePart) + "\n\n" + realtimeCtx;

            // Keys per provider
            const geminiKeys = [1,2,3,4,5].map(i=>process.env[`GEMINI_API_KEY_${i}`]).filter(Boolean);
            const groqKeys   = [1,2,3,4,5].map(i=>process.env[`GROQ_API_KEY_${i}`]).filter(Boolean);
            const orKeys     = [1,2,3,4,5].map(i=>process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean);

            // Kalau ada gambar: coba SEMUA gemini key satu per satu → semua OR key
            // Kalau teks: random 1 dari tiap provider, fallback berurutan
            let providerQueue;
            const pick = arr => arr.length ? arr[Math.floor(Math.random()*arr.length)] : null;

            if (hasImage) {
                // Gambar: coba semua Gemini key → OpenRouter vision
                providerQueue = [
                    ...geminiKeys.map(k => ({ name:'gemini', key:k })),
                    ...orKeys.map(k => ({ name:'openrouter', key:k }))
                ];
            } else {
                // Teks: prioritaskan provider yang sehat
                // Provider yang cooling (banyak error) diletakkan di belakang
                const allProviders = [
                    ...geminiKeys.map(k => ({ name:'gemini', key:k, cooling: isCooling('gemini') })),
                    ...groqKeys.map(k => ({ name:'groq', key:k, cooling: isCooling('groq') })),
                    ...orKeys.map(k => ({ name:'openrouter', key:k, cooling: isCooling('openrouter') })),
                ];
                // Sehat dulu, cooling belakang
                const healthy = allProviders.filter(p => !p.cooling);
                const cooling = allProviders.filter(p => p.cooling);
                // Shuffle masing-masing grup
                healthy.sort(() => Math.random()-0.5);
                cooling.sort(() => Math.random()-0.5);
                providerQueue = [...healthy, ...cooling];
            }

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
                    markSuccess(p.name);
                    usedProvider = p.name;
                    break;
                } catch(e) {
                    console.error(`[${p.name}] error:`, e.message);
                    lastError = e.message;
                    // Mark fail kalau 429 atau restricted
                    if (e.message.includes('429') || e.message.includes('restrict') || e.message.includes('quota')) {
                        markFail(p.name);
                    }
                }
            }

            // Last resort: HuggingFace gratis
            if (!aiResponse) {
                try {
                    aiResponse = await callHuggingFace(user_message || "Halo", systemPrompt);
                    usedProvider = "huggingface";
                } catch(e) {
                    console.error("[huggingface] error:", e.message);
                    lastError = e.message;
                }
            }

            if (!aiResponse) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar.",
                    error: lastError
                });
            }

            return res.status(200).json({
                response: aiResponse,
                provider: usedProvider
            });

        } catch(error) {
            console.error("Handler error:", error.message);
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
