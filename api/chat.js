import { createClient } from '@supabase/supabase-js';

// ==========================================
// SUPABASE (Minimal & Fail-safe)
// ==========================================
let supabase = null;

async function getSupabase() {
    if (supabase) return supabase;

    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!url || !key) return null;

        new URL(url); // validasi URL
        supabase = createClient(url, key);
        return supabase;
    } catch (e) {
        console.error("Supabase init error:", e.message);
        return null;
    }
}

// Simpan riwayat chat
async function saveChatHistory(userMessage, aiResponse) {
    const client = await getSupabase();
    if (!client) return; // skip jika tidak ada supabase

    try {
        await client.from('chat_history').insert([{
            user_message: userMessage,
            ai_response: aiResponse,
            created_at: new Date().toISOString()
        }));
    } catch (err) {
        console.error("Gagal simpan chat history:", err.message);
        // Tidak throw, hanya log
    }
}

// Ambil system prompt
async function getSystemPrompt() {
    const client = await getSupabase();
    if (!client) return null;

    try {
        const { data } = await client
            .from('ai_config')
            .select('value')
            .eq('key', 'system_prompt')
            .single();

        return data?.value || null;
    } catch (e) {
        console.error("Gagal ambil system prompt:", e.message);
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


export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query;

    // ====================== GET ======================
    if (req.method === 'GET') {
        if (action === 'debug') {
            // ... debug code kamu bisa tetap pakai
            return res.status(200).json({ /* ... */ });
        }

        if (action === 'get_prompt') {
            const prompt = await getSystemPrompt();
            return res.status(200).json({ prompt });
        }

        // Kalau mau ambil history chat (opsional)
        if (action === 'get_history') {
            const client = await getSupabase();
            if (!client) return res.status(200).json({ data: [] });

            const { data } = await client
                .from('chat_history')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(50);

            return res.status(200).json({ data: data || [] });
        }

        return res.status(200).json({ message: "OK" });
    }

    // ====================== POST ======================
    if (req.method === 'POST') {

        // Save Prompt
        if (action === 'save_prompt') {
            const client = await getSupabase();
            if (!client) return res.status(500).json({ error: "Supabase tidak tersedia" });

            const { prompt } = req.body;
            try {
                await client.from('ai_config').upsert({
                    key: 'system_prompt',
                    value: prompt
                }, { onConflict: 'key' });

                return res.status(200).json({ success: true });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // Save Chat History (bisa dipanggil terpisah)
        if (action === 'save_history') {
            const { user_message, ai_response } = req.body;
            await saveChatHistory(user_message, ai_response);
            return res.status(200).json({ success: true });
        }

        // ====================== CHAT UTAMA ======================
        try {
            const { user_message, user_image } = req.body;

            // Ambil custom system prompt
            const customPrompt = await getSystemPrompt();

            const systemPrompt = customPrompt || 
                `Kamu adalah XREZZ AI, asisten XREZZKY OFFICIAL STORE.\nJawab santai, sebut user dengan bro/kak.`;

            // Keys
            const geminiKeys = [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]).filter(Boolean);
            const groqKeys   = [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).filter(Boolean);
            const orKeys     = [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean);

            const allResults = await fetchAllProviders(
                systemPrompt, user_message, user_image,
                { geminiKeys, groqKeys, orKeys }
            );

            const successful = allResults.filter(r => r.ok && r.text);
            const failed = allResults.filter(r => !r.ok);

            if (successful.length === 0) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar ya 🙏",
                    error: failed.map(r => `${r.provider}: ${r.error}`).join(' | ')
                });
            }

            const synthesisKey = geminiKeys[0] || null;
            const finalResponse = await synthesizeResponses(synthesisKey, user_message, successful);

            // Simpan riwayat chat (fire and forget)
            saveChatHistory(user_message, finalResponse).catch(() => {});

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
