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
// GEMINI + GOOGLE SEARCH GROUNDING (REALTIME)
// ==========================================
async function callGemini(apiKey, systemPrompt, userMessage, userImage, useSearch = true) {
    const parts = [];
    if (userImage && userImage.includes(",")) {
        try {
            const split = userImage.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            parts.push({ inline_data: { data: split[1], mime_type: mimeType } });
        } catch (e) {}
    }
    parts.push({ text: userMessage || "Halo" });

    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }]
    };

    // Aktifkan Google Search grounding untuk info realtime
    if (useSearch) {
        body.tools = [{ google_search: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini: response kosong");

    // Ambil sumber grounding kalau ada
    const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
        .map(c => c.web?.uri)
        .filter(Boolean)
        .slice(0, 3);

    return { text, sources };
}

// ==========================================
// GROQ — teks only, tidak ada web search
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
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Groq: response kosong");
    return { text, sources: [] };
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
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenRouter: response kosong");
    return { text, sources: [] };
}

// ==========================================
// DETEKSI apakah pertanyaan butuh info realtime
// Aktifkan search untuk hampir semua pertanyaan faktual/informasi
// ==========================================
function needsRealtime(message) {
    if (!message) return false;

    // Pertanyaan yang TIDAK perlu search (percakapan ringan / toko sendiri)
    const skipKeywords = [
        'halo', 'hai', 'hi', 'hei', 'selamat', 'terima kasih', 'makasih',
        'oke', 'ok', 'siap', 'sip', 'thanks', 'bye', 'dadah'
    ];
    const lower = message.toLowerCase();
    if (skipKeywords.some(k => lower === k || lower.startsWith(k + ' '))) return false;

    // Semua pertanyaan faktual, informasi, atau apapun yang bukan sapaan → aktifkan search
    // Ini termasuk: berita, sains, teknologi, kesehatan, hukum, sejarah, dll
    const realtimeKeywords = [
        // Info & berita
        'berita', 'terbaru', 'terkini', 'hari ini', 'sekarang', 'update', 'trending', 'viral',
        'news', 'latest', 'today', 'current', 'now', 'live', 'breaking',
        // Cari / tanya info
        'cari', 'search', 'info', 'informasi', 'jelaskan', 'apa itu', 'siapa', 'dimana',
        'kapan', 'kenapa', 'mengapa', 'bagaimana', 'cara', 'gimana', 'apakah',
        'what', 'who', 'where', 'when', 'why', 'how', 'is', 'are', 'does',
        // Topik spesifik
        'harga', 'price', 'cuaca', 'weather', 'jadwal', 'schedule',
        'teknologi', 'tech', 'science', 'ilmu', 'kesehatan', 'health',
        'politik', 'hukum', 'ekonomi', 'bisnis', 'olahraga', 'sport',
        'film', 'musik', 'game', 'aplikasi', 'software', 'hardware',
        'tutorial', 'tips', 'cara', 'langkah', 'panduan', 'guide',
        // Sumber berita
        'kompas', 'detik', 'cnbc', 'tribun', 'wikipedia', 'google',
        // Umum
        '?'
    ];

    return realtimeKeywords.some(k => lower.includes(k));
}

// ==========================================
// PARALLEL FETCH semua provider
// ==========================================
async function fetchAllProviders(systemPrompt, userMessage, userImage, { geminiKeys, groqKeys, orKeys }) {
    const hasImage = !!(userImage && userImage.includes(","));
    const isRealtime = needsRealtime(userMessage);
    const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

    const tasks = [];

    // Gemini — pakai Google Search grounding kalau butuh realtime
    const gemKey = pick(geminiKeys);
    if (gemKey) {
        tasks.push(
            callGemini(gemKey, systemPrompt, userMessage, userImage, isRealtime)
                .then(r => ({ provider: 'gemini', text: r.text, sources: r.sources, ok: true, realtime: isRealtime }))
                .catch(e => {
                    console.error("Gemini error:", e.message);
                    // Retry tanpa search kalau gagal
                    return callGemini(gemKey, systemPrompt, userMessage, userImage, false)
                        .then(r => ({ provider: 'gemini', text: r.text, sources: [], ok: true, realtime: false }))
                        .catch(e2 => ({ provider: 'gemini', error: e2.message, ok: false }));
                })
        );
    }

    // Groq — skip kalau ada gambar
    if (!hasImage) {
        const groqKey = pick(groqKeys);
        if (groqKey) {
            tasks.push(
                callGroq(groqKey, systemPrompt, userMessage)
                    .then(r => ({ provider: 'groq', text: r.text, sources: [], ok: true }))
                    .catch(e => ({ provider: 'groq', error: e.message, ok: false }))
            );
        }
    }

    // OpenRouter
    const orKey = pick(orKeys);
    if (orKey) {
        tasks.push(
            callOpenRouter(orKey, systemPrompt, userMessage, userImage)
                .then(r => ({ provider: 'openrouter', text: r.text, sources: [], ok: true }))
                .catch(e => ({ provider: 'openrouter', error: e.message, ok: false }))
        );
    }

    const results = await Promise.allSettled(tasks);
    return results.map(r => r.status === 'fulfilled' ? r.value : { provider: 'unknown', ok: false, error: r.reason?.message });
}

// ==========================================
// SYNTHESIS — gabungkan semua jawaban
// ==========================================
async function synthesizeResponses(geminiKey, userQuestion, responses) {
    if (responses.length === 1) return { text: responses[0].text, sources: responses[0].sources || [] };

    // Prioritaskan jawaban Gemini yang pakai realtime search
    const realtimeRes = responses.find(r => r.realtime && r.provider === 'gemini');

    const combined = responses
        .map((r, i) => `[${r.provider.toUpperCase()}${r.realtime ? ' (REALTIME)' : ''}]\n${r.text}`)
        .join("\n\n---\n\n");

    const synthesisPrompt = `Kamu adalah AI synthesizer untuk XREZZKY OFFICIAL STORE.
Tugasmu menggabungkan beberapa jawaban AI menjadi SATU jawaban terbaik.

ATURAN PENTING:
- Jawaban dari sumber REALTIME (Google Search) = prioritas utama untuk fakta & berita
- Gabungkan info unik dari semua sumber
- Buang info yang saling bertentangan (prioritaskan realtime)
- Jangan sebut nama provider/sumber
- Bahasa santai, pakai bro/kak
- Format rapi, pakai bullet jika perlu
- JANGAN ngarang fakta yang tidak ada di jawaban manapun`;

    const userMsg = `Pertanyaan: "${userQuestion}"\n\nJawaban dari berbagai AI:\n\n${combined}\n\nBuat 1 jawaban terbaik:`;

    if (!geminiKey) {
        const best = realtimeRes || responses.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }

    try {
        const result = await callGemini(geminiKey, synthesisPrompt, userMsg, null, false);
        const allSources = [...new Set(responses.flatMap(r => r.sources || []))];
        return { text: result.text, sources: allSources };
    } catch (e) {
        console.error("Synthesis error:", e.message);
        const best = realtimeRes || responses.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }
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

    // ── GET ──────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
        if (action === 'debug') {
            const env = {
                SUPABASE_URL: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) : 'KOSONG',
                SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ada ✓' : 'KOSONG ✗',
                GEMINI: [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
                GROQ:   [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]   ? `key${i}:ada` : `key${i}:kosong`),
                OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
            };
            const providers = {};
            await Promise.allSettled([
                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.gemini = 'no_key'; return; }
                    const r = await callGemini(key, "Kamu asisten.", "Balas: OK", null, false);
                    providers.gemini = r.text ? 'OK ✓' : 'response kosong';
                })().catch(e => { providers.gemini = '✗ ' + e.message.slice(0,150); }),
                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.groq = 'no_key'; return; }
                    const r = await callGroq(key, "Kamu asisten.", "Balas: OK");
                    providers.groq = r.text ? 'OK ✓' : 'response kosong';
                })().catch(e => { providers.groq = '✗ ' + e.message.slice(0,150); }),
                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.openrouter = 'no_key'; return; }
                    const r = await callOpenRouter(key, "Kamu asisten.", "Balas: OK", null);
                    providers.openrouter = r.text ? 'OK ✓' : 'response kosong';
                })().catch(e => { providers.openrouter = '✗ ' + e.message.slice(0,150); }),
            ]);
            return res.status(200).json({ env, providers });
        }

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

        const supabase = await getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase tidak tersedia." });
        try {
            const { data, error } = await supabase.from('info_toko').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ data });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
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

        // ── CHAT UTAMA ────────────────────────────────────────────────────────
        try {
            const { user_message, user_image } = req.body;

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
                    if (knowledgeRes.data?.length > 0) {
                        knowledgeContext = knowledgeRes.data.map(i => `${i.judul}: ${i.content}`).join("\n");
                    }
                    if (promptRes.data?.value) {
                        customPrompt = promptRes.data.value;
                    }
                }
            } catch (e) {
                console.error("Supabase fetch error:", e.message);
            }

            const systemPrompt = customPrompt
                ? customPrompt.replace('{knowledge}', knowledgeContext || '-')
                : `Kamu adalah XREZZ AI — asisten super cerdas milik XREZZKY OFFICIAL STORE.

IDENTITAS:
- Nama: XREZZ AI
- Bahasa: Indonesia santai, pakai bro atau kak ke user
- Kepribadian: ramah, helpful, to the point, tidak lebay

KEMAMPUAN:
- Kamu bisa menjawab SEMUA jenis pertanyaan tanpa batasan topik apapun
- Teknologi, sains, kesehatan, hukum, keuangan, coding, sejarah, budaya, hiburan, dll
- Berita dan info terkini (gunakan hasil search yang tersedia)
- Pertanyaan seputar XREZZKY STORE (produk, harga, cara beli, dll)
- Analisis, opini, rekomendasi, tutorial — semua bisa

DATA TOKO XREZZKY:
${knowledgeContext || '(belum ada data toko)'}

ATURAN JAWABAN:
- Jawab akurat berdasarkan fakta atau hasil search — JANGAN mengarang
- Kalau tidak tahu atau tidak ada di hasil search → jujur bilang: gue kurang tau bro, coba cek langsung di sumbernya
- Kalau ada hasil search → manfaatkan maksimal untuk jawaban terkini dan akurat
- Format rapi: pakai bullet atau nomor kalau info banyak, paragraf kalau penjelasan
- Jawab langsung ke intinya, tidak perlu basa-basi panjang`;

            const geminiKeys = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).filter(Boolean);
            const groqKeys   = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).filter(Boolean);
            const orKeys     = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean);

            // Step 1: Fetch semua provider paralel
            const allResults = await fetchAllProviders(
                systemPrompt, user_message, user_image,
                { geminiKeys, groqKeys, orKeys }
            );

            const successful = allResults.filter(r => r.ok && r.text);
            const failed     = allResults.filter(r => !r.ok);

            console.log(`[MULTI] OK: ${successful.map(r => r.provider + (r.realtime ? '(RT)' : '')).join(', ')}`);
            if (failed.length) console.log(`[MULTI] FAIL: ${failed.map(r => `${r.provider}(${r.error})`).join(', ')}`);

            if (successful.length === 0) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar ya 🙏",
                    error: failed.map(r => `${r.provider}: ${r.error}`).join(' | ')
                });
            }

            // Step 2: Synthesis
            const synthesisKey = geminiKeys[0] || null;
            const final = await synthesizeResponses(synthesisKey, user_message, successful);

            return res.status(200).json({
                response: final.text,
                sources: final.sources,
                providers_used: successful.map(r => r.provider + (r.realtime ? '[RT]' : '')),
                providers_failed: failed.map(r => r.provider),
                synthesized: successful.length > 1,
                realtime: successful.some(r => r.realtime)
            });

        } catch (error) {
            console.error("Handler error:", error.message);
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
