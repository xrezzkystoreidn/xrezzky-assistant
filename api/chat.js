// ==========================================
// api/chat.js — Gemini Realtime Streaming
// + Google Search Grounding
// ==========================================
// Taruh file ini di /api/chat.js (Vercel)
// Env yang dipakai: GEMINI_API_KEY_1 s/d GEMINI_API_KEY_5
// + SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY (opsional, buat ambil system prompt & knowledge)
// ==========================================

import { createClient } from '@supabase/supabase-js';

const GEMINI_MODEL = "gemini-2.0-flash";

// ── Supabase (opsional) ───────────────────────────────────────────────────
async function getSupabase() {
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return null;
        new URL(url);
        return createClient(url, key);
    } catch (e) {
        return null;
    }
}

// ── Ambil knowledge + custom prompt dari Supabase ─────────────────────────
async function getContextFromSupabase() {
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
    } catch (e) {}
    return { knowledgeContext, customPrompt };
}

// ── Waktu WIB sekarang ────────────────────────────────────────────────────
function nowWIB() {
    return new Date().toLocaleString("id-ID", {
        dateStyle: "full",
        timeStyle: "medium",
        timeZone: "Asia/Jakarta"
    });
}

// ── Pick random key dari pool ─────────────────────────────────────────────
function pickGeminiKey() {
    const keys = [1, 2, 3, 4, 5]
        .map(i => process.env[`GEMINI_API_KEY_${i}`])
        .filter(Boolean);
    if (!keys.length) return null;
    return keys[Math.floor(Math.random() * keys.length)];
}

// ── Semua key (buat fallback) ─────────────────────────────────────────────
function getAllGeminiKeys() {
    return [1, 2, 3, 4, 5]
        .map(i => process.env[`GEMINI_API_KEY_${i}`])
        .filter(Boolean);
}

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method tidak diizinkan' });

    const { user_message, user_image, stream: wantStream } = req.body;

    if (!user_message && !user_image) {
        return res.status(400).json({ error: "user_message atau user_image wajib diisi" });
    }

    // Ambil context dari Supabase
    const { knowledgeContext, customPrompt } = await getContextFromSupabase();

    // Build system prompt
    const currentTime = nowWIB();
    const systemPrompt = customPrompt
        ? customPrompt.replace('{knowledge}', knowledgeContext || '-')
        : `Kamu adalah XREZZ AI, asisten cerdas XREZZKY OFFICIAL STORE.
Waktu sekarang (WIB): ${currentTime}
Kamu memiliki akses ke Google Search untuk mencari informasi terkini dan akurat dari internet.
Selalu gunakan informasi terbaru dari Google Search untuk menjawab pertanyaan tentang berita, harga, data terkini, dll.
Jika ditanya waktu/tanggal/hari, jawab berdasarkan waktu di atas.
${knowledgeContext ? 'Data toko:\n' + knowledgeContext : ''}
Bahasa: Indonesia informal (bro/kak). Jawab singkat tapi akurat dan lengkap.`;

    // Build contents (support gambar)
    const parts = [];
    if (user_image && user_image.includes(",")) {
        try {
            const split = user_image.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            parts.push({ inline_data: { data: split[1], mime_type: mimeType } });
        } catch (e) {}
    }
    parts.push({ text: user_message || "Halo" });

    const requestBody = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts }],
        tools: [{ google_search: {} }],   // ← Google Search Grounding aktif
        generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.7
        }
    };

    const keys = getAllGeminiKeys();
    if (!keys.length) {
        return res.status(500).json({ error: "Tidak ada GEMINI_API_KEY yang tersedia di env" });
    }

    // ── MODE STREAMING (stream: true) ─────────────────────────────────────
    // Gunakan Server-Sent Events (SSE)
    if (wantStream === true || wantStream === "true") {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let success = false;
        let lastError = null;

        for (const apiKey of keys) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`;

                const geminiRes = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                });

                if (!geminiRes.ok) {
                    const err = await geminiRes.text();
                    throw new Error(`Gemini ${geminiRes.status}: ${err.slice(0, 200)}`);
                }

                const reader = geminiRes.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const raw = line.slice(6).trim();
                        if (!raw || raw === "[DONE]") continue;
                        try {
                            const chunk = JSON.parse(raw);
                            const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) {
                                // Kirim SSE event
                                res.write(`data: ${JSON.stringify({ text })}\n\n`);
                            }
                        } catch {}
                    }
                }

                // Selesai streaming
                res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                res.end();
                success = true;
                break;

            } catch (e) {
                console.error(`[gemini-stream] key error:`, e.message);
                lastError = e.message;
            }
        }

        if (!success) {
            res.write(`data: ${JSON.stringify({ error: lastError || "Semua Gemini key gagal" })}\n\n`);
            res.end();
        }
        return;
    }

    // ── MODE NORMAL (non-streaming, fallback) ─────────────────────────────
    let aiResponse = null;
    let lastError = null;

    for (const apiKey of keys) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

            const geminiRes = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody)
            });

            if (!geminiRes.ok) {
                const err = await geminiRes.text();
                throw new Error(`Gemini ${geminiRes.status}: ${err.slice(0, 200)}`);
            }

            const data = await geminiRes.json();
            aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!aiResponse) throw new Error("Response kosong dari Gemini");
            break;

        } catch (e) {
            console.error(`[gemini] key error:`, e.message);
            lastError = e.message;
        }
    }

    if (!aiResponse) {
        return res.status(500).json({
            response: "Semua Gemini key lagi error bro, coba lagi bentar.",
            error: lastError
        });
    }

    return res.status(200).json({ response: aiResponse, provider: "gemini" });
}
