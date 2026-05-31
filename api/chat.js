import { createClient } from '@supabase/supabase-js';

// ==========================================
// SUPABASE — fix DEP0169, no url.parse()
// ==========================================
let _supabase = null;
function getSupabase() {
    if (_supabase) return _supabase;
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!url || !key || !url.startsWith('https://')) return null;
    try {
        _supabase = createClient(url, key, {
            auth: { persistSession: false }
        });
        return _supabase;
    } catch (e) {
        console.error('[Supabase] init error:', e.message);
        return null;
    }
}

// ==========================================
// KEY ROTATION — 5 key per provider
// Rotasi round-robin berdasarkan waktu
// ==========================================
const _keyIndex = { gemini: 0, groq: 0, openrouter: 0 };

function getKeys(provider) {
    const envMap = {
        gemini:      'GEMINI_API_KEY_',
        groq:        'GROQ_API_KEY_',
        openrouter:  'OPENROUTER_API_KEY_'
    };
    const prefix = envMap[provider];
    return [1,2,3,4,5].map(i => process.env[`${prefix}${i}`]).filter(Boolean);
}

function pickKey(provider) {
    const keys = getKeys(provider);
    if (!keys.length) return null;
    const idx = _keyIndex[provider] % keys.length;
    _keyIndex[provider] = (idx + 1) % keys.length;
    return keys[idx];
}

// ==========================================
// GEMINI — dengan Google Search grounding
// ==========================================
async function callGemini(apiKey, systemPrompt, userMessage, userImage, useSearch) {
    const parts = [];
    if (userImage) {
        try {
            const [meta, b64] = userImage.split(',');
            const mimeType = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
            parts.push({ inline_data: { data: b64, mime_type: mimeType } });
        } catch (_) {}
    }
    parts.push({ text: userMessage || 'Halo' });

    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
    };
    if (useSearch) body.tools = [{ google_search: {} }];

    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: empty response');

    const sources = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .map(c => c.web?.uri).filter(Boolean).slice(0, 3);

    return { text, sources };
}

// ==========================================
// GROQ — teks only, Llama 3.1 8B instant
// ==========================================
async function callGroq(apiKey, systemPrompt, userMessage) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage || 'Halo' }
            ],
            max_tokens: 1024,
            temperature: 0.7
        })
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq: empty response');
    return { text, sources: [] };
}

// ==========================================
// OPENROUTER — teks & gambar
// ==========================================
async function callOpenRouter(apiKey, systemPrompt, userMessage, userImage) {
    let userContent;
    if (userImage) {
        try {
            const [meta, b64] = userImage.split(',');
            const mimeType = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
            userContent = [
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
                { type: 'text', text: userMessage || 'Lihat gambar ini' }
            ];
        } catch (_) { userContent = userMessage || 'Halo'; }
    } else {
        userContent = userMessage || 'Halo';
    }

    const model = userImage
        ? 'google/gemini-2.0-flash-001'
        : 'meta-llama/llama-3.1-8b-instruct:free';

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://xrezzky-assistant.vercel.app',
            'X-Title': 'XREZZKY OFFICIAL STORE'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            max_tokens: 1024
        })
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenRouter: empty response');
    return { text, sources: [] };
}

// ==========================================
// DETEKSI butuh realtime search atau tidak
// ==========================================
function needsSearch(msg) {
    if (!msg) return false;
    const skip = ['halo','hai','hi','hei','oke','ok','sip','siap','makasih','thanks','terima kasih','bye','dadah'];
    const lower = msg.toLowerCase().trim();
    if (skip.some(k => lower === k || lower === k + '!')) return false;
    // Aktifkan search untuk semua kalimat tanya / info faktual
    const triggers = [
        '?','apa','siapa','dimana','kapan','kenapa','mengapa','bagaimana','gimana','berapa',
        'cari','search','berita','info','terbaru','terkini','sekarang','hari ini','update',
        'harga','cuaca','jadwal','trending','viral','news','latest','today','current',
        'teknologi','kesehatan','hukum','ekonomi','sport','film','musik','game',
        'cara','tutorial','tips','panduan','jelaskan','maksud','artinya',
        'kompas','detik','cnbc','wikipedia','google'
    ];
    return triggers.some(k => lower.includes(k));
}

// ==========================================
// PARALLEL FETCH — semua provider sekaligus
// Masing-masing pakai key rotation
// ==========================================
async function fetchAllProviders(systemPrompt, userMessage, userImage) {
    const hasImage = !!userImage;
    const useSearch = needsSearch(userMessage);

    const tasks = [];

    // --- Gemini ---
    const gemKey = pickKey('gemini');
    if (gemKey) {
        tasks.push(
            callGemini(gemKey, systemPrompt, userMessage, userImage, useSearch)
                .then(r => ({ provider: 'gemini', text: r.text, sources: r.sources, ok: true, realtime: useSearch }))
                .catch(async e => {
                    console.error('[Gemini] error, retry no-search:', e.message);
                    // Retry dengan key berikutnya tanpa search
                    const key2 = pickKey('gemini');
                    if (!key2) return { provider: 'gemini', ok: false, error: e.message };
                    return callGemini(key2, systemPrompt, userMessage, userImage, false)
                        .then(r => ({ provider: 'gemini', text: r.text, sources: [], ok: true, realtime: false }))
                        .catch(e2 => ({ provider: 'gemini', ok: false, error: e2.message }));
                })
        );
    }

    // --- Groq — skip kalau ada gambar ---
    if (!hasImage) {
        const groqKey = pickKey('groq');
        if (groqKey) {
            tasks.push(
                callGroq(groqKey, systemPrompt, userMessage)
                    .then(r => ({ provider: 'groq', text: r.text, sources: [], ok: true }))
                    .catch(async e => {
                        console.error('[Groq] error, retry next key:', e.message);
                        const key2 = pickKey('groq');
                        if (!key2) return { provider: 'groq', ok: false, error: e.message };
                        return callGroq(key2, systemPrompt, userMessage)
                            .then(r => ({ provider: 'groq', text: r.text, sources: [], ok: true }))
                            .catch(e2 => ({ provider: 'groq', ok: false, error: e2.message }));
                    })
            );
        }
    }

    // --- OpenRouter ---
    const orKey = pickKey('openrouter');
    if (orKey) {
        tasks.push(
            callOpenRouter(orKey, systemPrompt, userMessage, userImage)
                .then(r => ({ provider: 'openrouter', text: r.text, sources: [], ok: true }))
                .catch(async e => {
                    console.error('[OpenRouter] error, retry next key:', e.message);
                    const key2 = pickKey('openrouter');
                    if (!key2) return { provider: 'openrouter', ok: false, error: e.message };
                    return callOpenRouter(key2, systemPrompt, userMessage, userImage)
                        .then(r => ({ provider: 'openrouter', text: r.text, sources: [], ok: true }))
                        .catch(e2 => ({ provider: 'openrouter', ok: false, error: e2.message }));
                })
        );
    }

    const settled = await Promise.allSettled(tasks);
    return settled.map(r => r.status === 'fulfilled' ? r.value : { provider: 'unknown', ok: false, error: r.reason?.message });
}

// ==========================================
// SYNTHESIS — gabungkan semua jawaban
// ==========================================
async function synthesize(userQuestion, responses) {
    const ok = responses.filter(r => r.ok && r.text);
    if (ok.length === 0) return null;
    if (ok.length === 1) return { text: ok[0].text, sources: ok[0].sources || [] };

    // Prioritaskan realtime Gemini
    const realtimeRes = ok.find(r => r.realtime && r.provider === 'gemini');

    const combined = ok.map(r =>
        `[${r.provider.toUpperCase()}${r.realtime ? ' ★REALTIME' : ''}]\n${r.text}`
    ).join('\n\n---\n\n');

    const sysPrompt = `Kamu adalah synthesizer AI. Tugasmu: gabungkan beberapa jawaban AI menjadi SATU jawaban terbaik.
ATURAN:
- Sumber REALTIME (★) = prioritas untuk fakta & berita terkini
- Ambil info terbaik & unik dari semua sumber
- Buang duplikat, pilih yang paling akurat jika bertentangan
- Jangan sebut nama provider atau sumber
- Bahasa santai Indonesia, pakai bro/kak
- Format rapi: bullet/nomor kalau info banyak
- Langsung ke intinya, tidak perlu basa-basi`;

    const gemKey = pickKey('gemini');
    if (!gemKey) {
        const best = realtimeRes || ok.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }

    try {
        const r = await callGemini(
            gemKey, sysPrompt,
            `Pertanyaan: "${userQuestion}"\n\nJawaban:\n\n${combined}\n\nBuat 1 jawaban terbaik:`,
            null, false
        );
        const allSources = [...new Set(ok.flatMap(r => r.sources || []))];
        return { text: r.text, sources: allSources };
    } catch (e) {
        console.error('[Synthesis] fallback:', e.message);
        const best = realtimeRes || ok.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }
}

// ==========================================
// SYSTEM PROMPT — unlimited, akurat, santai
// ==========================================
function buildSystemPrompt(knowledgeContext, customPrompt) {
    if (customPrompt) return customPrompt.replace('{knowledge}', knowledgeContext || '-');
    return `Kamu adalah XREZZ AI — asisten cerdas milik XREZZKY OFFICIAL STORE.

IDENTITAS:
- Nama: XREZZ AI by XREZZKY OFFICIAL STORE
- Bahasa: Indonesia santai, pakai "bro" atau "kak"
- Kepribadian: ramah, helpful, to the point, tidak lebay

KEMAMPUAN (tidak ada batasan topik):
- Berita & info terkini → gunakan hasil Google Search yang tersedia
- Teknologi, sains, kesehatan, hukum, keuangan, coding, sejarah, hiburan, dll
- Pertanyaan soal XREZZKY STORE: produk, harga, cara beli, promo
- Tutorial, tips, analisis, rekomendasi, opini — semua bisa

DATA TOKO XREZZKY:
${knowledgeContext || '(belum ada data — tambahkan via admin panel)'}

ATURAN:
- Fakta & berita → andalkan hasil search, JANGAN mengarang
- Kalau tidak tahu → jujur: "gue kurang tau bro, cek langsung di sumbernya ya"
- Format rapi: bullet/nomor kalau info banyak, paragraf kalau penjelasan
- Langsung ke inti jawaban`;
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

    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
        if (action === 'debug') {
            const status = {};
            await Promise.allSettled([
                (async () => {
                    const key = pickKey('gemini');
                    if (!key) { status.gemini = 'no_key'; return; }
                    await callGemini(key, 'Kamu asisten.', 'Balas: OK', null, false);
                    status.gemini = 'OK ✓';
                })().catch(e => { status.gemini = '✗ ' + e.message.slice(0,100); }),
                (async () => {
                    const key = pickKey('groq');
                    if (!key) { status.groq = 'no_key'; return; }
                    await callGroq(key, 'Kamu asisten.', 'Balas: OK');
                    status.groq = 'OK ✓';
                })().catch(e => { status.groq = '✗ ' + e.message.slice(0,100); }),
                (async () => {
                    const key = pickKey('openrouter');
                    if (!key) { status.openrouter = 'no_key'; return; }
                    await callOpenRouter(key, 'Kamu asisten.', 'Balas: OK', null);
                    status.openrouter = 'OK ✓';
                })().catch(e => { status.openrouter = '✗ ' + e.message.slice(0,100); }),
            ]);
            return res.status(200).json({
                status,
                keys: {
                    gemini:     getKeys('gemini').length,
                    groq:       getKeys('groq').length,
                    openrouter: getKeys('openrouter').length
                },
                supabase: getSupabase() ? 'OK ✓' : 'KOSONG ✗'
            });
        }

        if (action === 'get_prompt') {
            const sb = getSupabase();
            if (!sb) return res.status(200).json({ prompt: null });
            try {
                const { data } = await sb.from('ai_config').select('value').eq('key','system_prompt').single();
                return res.status(200).json({ prompt: data?.value || null });
            } catch { return res.status(200).json({ prompt: null }); }
        }

        // GET all knowledge
        const sb = getSupabase();
        if (!sb) return res.status(500).json({ error: 'Supabase tidak tersedia.' });
        try {
            const { data, error } = await sb.from('info_toko').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ data });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // ── POST ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
        const sb = getSupabase();

        if (action === 'save_context') {
            if (!sb) return res.status(500).json({ error: 'Supabase tidak tersedia.' });
            try {
                const { kategori, judul, content } = req.body;
                const { data, error } = await sb.from('info_toko').insert([{ kategori, judul, content }]);
                if (error) throw error;
                return res.status(200).json({ success: true, data });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        if (action === 'delete_context') {
            if (!sb) return res.status(500).json({ error: 'Supabase tidak tersedia.' });
            try {
                const { id } = req.body;
                const { error } = await sb.from('info_toko').delete().eq('id', id);
                if (error) throw error;
                return res.status(200).json({ success: true });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        if (action === 'save_prompt') {
            if (!sb) return res.status(500).json({ error: 'Supabase tidak tersedia.' });
            try {
                const { prompt } = req.body;
                const { error } = await sb.from('ai_config')
                    .upsert({ key: 'system_prompt', value: prompt }, { onConflict: 'key' });
                if (error) throw error;
                return res.status(200).json({ success: true });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        // ── CHAT UTAMA ────────────────────────────────────────────────────
        try {
            const { user_message, user_image } = req.body;

            // Ambil knowledge + custom prompt dari Supabase (paralel)
            let knowledgeContext = '';
            let customPrompt = null;
            try {
                if (sb) {
                    const [kRes, pRes] = await Promise.all([
                        sb.from('info_toko').select('judul, content').limit(20),
                        sb.from('ai_config').select('value').eq('key','system_prompt').single()
                    ]);
                    if (kRes.data?.length) {
                        knowledgeContext = kRes.data.map(i => `${i.judul}: ${i.content}`).join('\n');
                    }
                    if (pRes.data?.value) customPrompt = pRes.data.value;
                }
            } catch (e) {
                console.error('[Supabase] fetch error:', e.message);
            }

            const systemPrompt = buildSystemPrompt(knowledgeContext, customPrompt);

            // Fetch semua provider paralel
            const allResults = await fetchAllProviders(systemPrompt, user_message, user_image);
            const successful = allResults.filter(r => r.ok && r.text);
            const failed     = allResults.filter(r => !r.ok);

            console.log(`[CHAT] OK: ${successful.map(r => r.provider + (r.realtime ? '(RT)' : '')).join(', ') || 'none'}`);
            if (failed.length) console.log(`[CHAT] FAIL: ${failed.map(r => `${r.provider}:${r.error?.slice(0,60)}`).join(', ')}`);

            if (!successful.length) {
                return res.status(500).json({
                    response: 'Semua AI provider lagi down bro, coba lagi bentar ya 🙏',
                    error: failed.map(r => `${r.provider}: ${r.error}`).join(' | ')
                });
            }

            // Synthesis
            const final = await synthesize(user_message, allResults);
            if (!final) {
                return res.status(500).json({ response: 'Gagal generate jawaban bro, coba lagi.' });
            }

            return res.status(200).json({
                response: final.text,
                sources: final.sources,
                providers_used:   successful.map(r => r.provider + (r.realtime ? '[RT]' : '')),
                providers_failed: failed.map(r => r.provider),
                synthesized: successful.length > 1,
                realtime: successful.some(r => r.realtime)
            });

        } catch (e) {
            console.error('[Handler] error:', e.message);
            return res.status(500).json({ response: 'Server error bro.', error: e.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
