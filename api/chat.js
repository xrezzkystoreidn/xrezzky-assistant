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
// GEMINI
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
// OPENROUTER
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
    return data.choices[0].message.content;
}

// ==========================================
// SYNTHESIS — gabungkan semua jawaban dari 3 provider
// Gunakan Gemini (atau fallback teks) untuk merangkum
// ==========================================
async function synthesizeResponses(geminiKey, userQuestion, responses) {
    // responses = [{ provider, text }, ...]
    if (responses.length === 1) return responses[0].text; // Kalau cuma 1, langsung return

    const combined = responses
        .map((r, i) => `[Sumber ${i + 1} - ${r.provider.toUpperCase()}]\n${r.text}`)
        .join("\n\n---\n\n");

    const synthesisPrompt = `Kamu adalah AI synthesizer. Tugasmu adalah menggabungkan beberapa jawaban dari AI yang berbeda menjadi SATU jawaban yang paling akurat, lengkap, dan informatif.

ATURAN:
- Gabungkan informasi terbaik dari semua sumber
- Hilangkan duplikat dan info yang saling bertentangan (pilih yang paling logis/akurat)
- Jika ada informasi tambahan dari sumber berbeda, sertakan semua yang relevan
- Jawab dengan bahasa yang natural, santai, tapi informatif
- Jangan sebut "Sumber 1", "Sumber 2" — langsung sajikan sebagai jawaban tunggal
- Gunakan sapaan bro/kak ke user
- Format jawaban rapi, gunakan bullet/nomor kalau perlu`;

    const userMsg = `Pertanyaan user: "${userQuestion}"\n\nJawaban dari berbagai AI:\n\n${combined}\n\nSintesiskan menjadi 1 jawaban terbaik dan paling akurat:`;

    if (!geminiKey) {
        // Fallback: pilih jawaban terpanjang (biasanya paling lengkap)
        return responses.reduce((a, b) => a.text.length >= b.text.length ? a : b).text;
    }

    try {
        return await callGemini(geminiKey, synthesisPrompt, userMsg, null);
    } catch (e) {
        console.error("Synthesis error:", e.message);
        // Fallback: pilih jawaban terpanjang
        return responses.reduce((a, b) => a.text.length >= b.text.length ? a : b).text;
    }
}

// ==========================================
// PARALLEL FETCH — query semua provider sekaligus
// ==========================================
async function fetchAllProviders(systemPrompt, userMessage, userImage, { geminiKeys, groqKeys, orKeys }) {
    const hasImage = !!(userImage && userImage.includes(","));

    // Pilih 1 key acak per provider untuk query paralel
    const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

    const tasks = [];

    // Gemini
    const gemKey = pick(geminiKeys);
    if (gemKey) {
        tasks.push(
            callGemini(gemKey, systemPrompt, userMessage, userImage)
                .then(text => ({ provider: 'gemini', text, ok: true }))
                .catch(e => ({ provider: 'gemini', error: e.message, ok: false }))
        );
    }

    // Groq (teks saja, skip kalau ada gambar)
    if (!hasImage) {
        const groqKey = pick(groqKeys);
        if (groqKey) {
            tasks.push(
                callGroq(groqKey, systemPrompt, userMessage)
                    .then(text => ({ provider: 'groq', text, ok: true }))
                    .catch(e => ({ provider: 'groq', error: e.message, ok: false }))
            );
        }
    }

    // OpenRouter
    const orKey = pick(orKeys);
    if (orKey) {
        tasks.push(
            callOpenRouter(orKey, systemPrompt, userMessage, userImage)
                .then(text => ({ provider: 'openrouter', text, ok: true }))
                .catch(e => ({ provider: 'openrouter', error: e.message, ok: false }))
        );
    }

    // Jalankan semua paralel, tunggu semua selesai (Promise.allSettled supaya tidak stop kalau 1 gagal)
    const results = await Promise.allSettled(tasks);
    return results.map(r => r.status === 'fulfilled' ? r.value : { provider: 'unknown', ok: false, error: r.reason?.message });
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
                SUPABASE_URL: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) : 'KOSONG',
                SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'ada ✓' : 'KOSONG ✗',
                GEMINI: [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
                GROQ:   [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]   ? `key${i}:ada` : `key${i}:kosong`),
                OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:ada` : `key${i}:kosong`),
            };
            const providers = {};
            const testMsg = "Balas: OK";
            const testSys = "Kamu asisten.";

            await Promise.allSettled([
                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.gemini = 'no_key'; return; }
                    await callGemini(key, testSys, testMsg, null);
                    providers.gemini = 'OK ✓';
                })().catch(e => { providers.gemini = '✗ ' + e.message.slice(0,150); }),

                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.groq = 'no_key'; return; }
                    await callGroq(key, testSys, testMsg);
                    providers.groq = 'OK ✓';
                })().catch(e => { providers.groq = '✗ ' + e.message.slice(0,150); }),

                (async () => {
                    const key = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).find(Boolean);
                    if (!key) { providers.openrouter = 'no_key'; return; }
                    await callOpenRouter(key, testSys, testMsg, null);
                    providers.openrouter = 'OK ✓';
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

        // ==========================================
        // CHAT UTAMA — REALTIME MULTI-PROVIDER
        // ==========================================
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
                : `Kamu adalah XREZZ AI, asisten XREZZKY OFFICIAL STORE.\n${knowledgeContext ? 'Data toko:\n' + knowledgeContext : ''}\nJawab santai, sebut user dengan bro/kak.`;

            const geminiKeys = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).filter(Boolean);
            const groqKeys   = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).filter(Boolean);
            const orKeys     = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean);

            // ── STEP 1: Query semua provider paralel ──────────────────────────
            const allResults = await fetchAllProviders(
                systemPrompt, user_message, user_image,
                { geminiKeys, groqKeys, orKeys }
            );

            // Pisahkan yang sukses dan gagal
            const successful = allResults.filter(r => r.ok && r.text);
            const failed     = allResults.filter(r => !r.ok);

            console.log(`[MULTI-PROVIDER] Berhasil: ${successful.map(r => r.provider).join(', ') || 'tidak ada'}`);
            if (failed.length) console.log(`[MULTI-PROVIDER] Gagal: ${failed.map(r => `${r.provider}(${r.error})`).join(', ')}`);

            if (successful.length === 0) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar ya 🙏",
                    error: failed.map(r => `${r.provider}: ${r.error}`).join(' | ')
                });
            }

            // ── STEP 2: Synthesis ─────────────────────────────────────────────
            // Kalau cuma 1 provider yang berhasil, langsung return (tidak perlu synthesis)
            // Kalau >1, synthesis pakai Gemini untuk jawaban terbaik
            const synthesisKey = geminiKeys[0] || null;
            const finalResponse = await synthesizeResponses(synthesisKey, user_message, successful);

            return res.status(200).json({
                response: finalResponse,
                providers_used: successful.map(r => r.provider),
                providers_failed: failed.map(r => r.provider),
                synthesized: successful.length > 1
            });

        } catch (error) {
            console.error("Handler error:", error.message);
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
