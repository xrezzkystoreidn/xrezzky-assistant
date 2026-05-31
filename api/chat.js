// ==========================================
// SUPABASE — pure fetch, no library, no DEP0169
// ==========================================
function sbFetch(path, options = {}) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase env kosong');
    return fetch(`${url}/rest/v1${path}`, {
        ...options,
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': options.prefer || 'return=representation',
            ...(options.headers || {})
        }
    });
}

async function sbSelect(table, query = '', single = false) {
    const res = await sbFetch(`/${table}?${query}`, {
        prefer: single ? 'return=representation' : 'return=representation'
    });
    if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status}`);
    return res.json();
}

async function sbInsert(table, body) {
    const res = await sbFetch(`/${table}`, {
        method: 'POST',
        body: JSON.stringify(body),
        prefer: 'return=representation'
    });
    if (!res.ok) throw new Error(`Supabase INSERT ${table}: ${res.status}`);
    return res.json();
}

async function sbDelete(table, query) {
    const res = await sbFetch(`/${table}?${query}`, { method: 'DELETE', prefer: 'return=minimal' });
    if (!res.ok) throw new Error(`Supabase DELETE ${table}: ${res.status}`);
    return true;
}

async function sbUpsert(table, body, onConflict) {
    const res = await sbFetch(`/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        body: JSON.stringify(body),
        prefer: 'resolution=merge-duplicates,return=minimal'
    });
    if (!res.ok) throw new Error(`Supabase UPSERT ${table}: ${res.status}`);
    return true;
}

// ==========================================
// KEY ROTATION — round-robin per provider
// ==========================================
const _idx = { gemini: 0, groq: 0, openrouter: 0 };

function getKeys(provider) {
    const p = { gemini: 'GEMINI_API_KEY_', groq: 'GROQ_API_KEY_', openrouter: 'OPENROUTER_API_KEY_' }[provider];
    return [1,2,3,4,5].map(i => process.env[`${p}${i}`]).filter(Boolean);
}

function pickKey(provider) {
    const keys = getKeys(provider);
    if (!keys.length) return null;
    const k = keys[_idx[provider] % keys.length];
    _idx[provider] = (_idx[provider] + 1) % keys.length;
    return k;
}

// ==========================================
// GEMINI + Google Search grounding
// ==========================================
async function callGemini(apiKey, systemPrompt, userMessage, userImage, useSearch) {
    const parts = [];
    if (userImage) {
        try {
            const [meta, b64] = userImage.split(',');
            const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
            parts.push({ inline_data: { data: b64, mime_type: mime } });
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
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: empty response');
    const sources = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .map(c => c.web?.uri).filter(Boolean).slice(0, 3);
    return { text, sources };
}

// ==========================================
// GROQ — teks only
// ==========================================
async function callGroq(apiKey, systemPrompt, userMessage) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage || 'Halo' }],
            max_tokens: 1024, temperature: 0.7
        })
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0,200)}`);
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
            const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
            userContent = [
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
                { type: 'text', text: userMessage || 'Lihat gambar ini' }
            ];
        } catch (_) { userContent = userMessage || 'Halo'; }
    } else {
        userContent = userMessage || 'Halo';
    }
    const model = userImage ? 'google/gemini-2.0-flash-001' : 'meta-llama/llama-3.1-8b-instruct:free';
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
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
            max_tokens: 1024
        })
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0,200)}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenRouter: empty response');
    return { text, sources: [] };
}

// ==========================================
// DETEKSI butuh search atau tidak
// ==========================================
function needsSearch(msg) {
    if (!msg) return false;
    const skip = ['halo','hai','hi','hei','oke','ok','sip','siap','makasih','thanks','terima kasih','bye','dadah'];
    const lower = msg.toLowerCase().trim();
    if (skip.some(k => lower === k || lower === k + '!')) return false;
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
// PARALLEL FETCH — semua provider + auto retry
// ==========================================
async function fetchAllProviders(systemPrompt, userMessage, userImage) {
    const hasImage = !!userImage;
    const useSearch = needsSearch(userMessage);
    const tasks = [];

    // Gemini
    const gemKey = pickKey('gemini');
    if (gemKey) {
        tasks.push(
            callGemini(gemKey, systemPrompt, userMessage, userImage, useSearch)
                .then(r => ({ provider: 'gemini', text: r.text, sources: r.sources, ok: true, realtime: useSearch }))
                .catch(async e => {
                    console.error('[Gemini] retry:', e.message);
                    const k2 = pickKey('gemini');
                    if (!k2) return { provider: 'gemini', ok: false, error: e.message };
                    return callGemini(k2, systemPrompt, userMessage, userImage, false)
                        .then(r => ({ provider: 'gemini', text: r.text, sources: [], ok: true, realtime: false }))
                        .catch(e2 => ({ provider: 'gemini', ok: false, error: e2.message }));
                })
        );
    }

    // Groq — skip kalau ada gambar
    if (!hasImage) {
        const groqKey = pickKey('groq');
        if (groqKey) {
            tasks.push(
                callGroq(groqKey, systemPrompt, userMessage)
                    .then(r => ({ provider: 'groq', text: r.text, sources: [], ok: true }))
                    .catch(async e => {
                        console.error('[Groq] retry:', e.message);
                        const k2 = pickKey('groq');
                        if (!k2) return { provider: 'groq', ok: false, error: e.message };
                        return callGroq(k2, systemPrompt, userMessage)
                            .then(r => ({ provider: 'groq', text: r.text, sources: [], ok: true }))
                            .catch(e2 => ({ provider: 'groq', ok: false, error: e2.message }));
                    })
            );
        }
    }

    // OpenRouter
    const orKey = pickKey('openrouter');
    if (orKey) {
        tasks.push(
            callOpenRouter(orKey, systemPrompt, userMessage, userImage)
                .then(r => ({ provider: 'openrouter', text: r.text, sources: [], ok: true }))
                .catch(async e => {
                    console.error('[OpenRouter] retry:', e.message);
                    const k2 = pickKey('openrouter');
                    if (!k2) return { provider: 'openrouter', ok: false, error: e.message };
                    return callOpenRouter(k2, systemPrompt, userMessage, userImage)
                        .then(r => ({ provider: 'openrouter', text: r.text, sources: [], ok: true }))
                        .catch(e2 => ({ provider: 'openrouter', ok: false, error: e2.message }));
                })
        );
    }

    const settled = await Promise.allSettled(tasks);
    return settled.map(r => r.status === 'fulfilled' ? r.value : { provider: 'unknown', ok: false, error: r.reason?.message });
}

// ==========================================
// SYNTHESIS
// ==========================================
async function synthesize(userQuestion, results) {
    const ok = results.filter(r => r.ok && r.text);
    if (!ok.length) return null;
    if (ok.length === 1) return { text: ok[0].text, sources: ok[0].sources || [] };

    const realtimeRes = ok.find(r => r.realtime);
    const combined = ok.map(r => `[${r.provider.toUpperCase()}${r.realtime ? ' ★REALTIME' : ''}]\n${r.text}`).join('\n\n---\n\n');

    const sysPrompt = `Kamu synthesizer AI. Gabungkan beberapa jawaban jadi SATU jawaban terbaik.
- Sumber ★REALTIME = prioritas untuk fakta & berita
- Ambil info terbaik dari semua sumber, buang duplikat
- Jangan sebut nama provider
- Bahasa santai Indonesia, pakai bro/kak
- Format rapi, langsung ke inti`;

    const gemKey = pickKey('gemini');
    if (!gemKey) {
        const best = realtimeRes || ok.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }
    try {
        const r = await callGemini(gemKey, sysPrompt,
            `Pertanyaan: "${userQuestion}"\n\n${combined}\n\nBuat 1 jawaban terbaik:`, null, false);
        return { text: r.text, sources: [...new Set(ok.flatMap(r => r.sources || []))] };
    } catch (e) {
        console.error('[Synthesis] fallback:', e.message);
        const best = realtimeRes || ok.reduce((a, b) => a.text.length >= b.text.length ? a : b);
        return { text: best.text, sources: best.sources || [] };
    }
}

// ==========================================
// SYSTEM PROMPT
// ==========================================
function buildSystemPrompt(knowledge, custom) {
    if (custom) return custom.replace('{knowledge}', knowledge || '-');
    return `Kamu adalah XREZZ AI — asisten cerdas milik XREZZKY OFFICIAL STORE.

IDENTITAS:
- Nama: XREZZ AI by XREZZKY OFFICIAL STORE
- Bahasa: Indonesia santai, pakai "bro" atau "kak"
- Kepribadian: ramah, helpful, to the point

KEMAMPUAN (tidak ada batasan topik):
- Berita & info terkini → gunakan hasil Google Search
- Teknologi, sains, kesehatan, hukum, keuangan, coding, sejarah, hiburan, dll
- Info XREZZKY STORE: produk, harga, cara beli, promo
- Tutorial, tips, analisis, rekomendasi — semua bisa

DATA TOKO XREZZKY:
${knowledge || '(belum ada data toko)'}

ATURAN:
- Fakta & berita → andalkan hasil search, JANGAN mengarang
- Kalau tidak tahu → jujur: "gue kurang tau bro, cek langsung ya"
- Format rapi, langsung ke inti jawaban`;
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
                (async () => { const k = pickKey('gemini'); if (!k) { status.gemini='no_key'; return; } await callGemini(k,'Kamu asisten.','Balas OK',null,false); status.gemini='OK ✓'; })()
                    .catch(e => { status.gemini = '✗ ' + e.message.slice(0,80); }),
                (async () => { const k = pickKey('groq'); if (!k) { status.groq='no_key'; return; } await callGroq(k,'Kamu asisten.','Balas OK'); status.groq='OK ✓'; })()
                    .catch(e => { status.groq = '✗ ' + e.message.slice(0,80); }),
                (async () => { const k = pickKey('openrouter'); if (!k) { status.openrouter='no_key'; return; } await callOpenRouter(k,'Kamu asisten.','Balas OK',null); status.openrouter='OK ✓'; })()
                    .catch(e => { status.openrouter = '✗ ' + e.message.slice(0,80); }),
            ]);
            return res.status(200).json({
                status,
                keys: { gemini: getKeys('gemini').length, groq: getKeys('groq').length, openrouter: getKeys('openrouter').length },
                supabase: process.env.SUPABASE_URL ? 'URL ada ✓' : 'KOSONG ✗'
            });
        }

        if (action === 'get_prompt') {
            try {
                const data = await sbSelect('ai_config', 'select=value&key=eq.system_prompt&limit=1');
                return res.status(200).json({ prompt: data?.[0]?.value || null });
            } catch { return res.status(200).json({ prompt: null }); }
        }

        // GET all knowledge
        try {
            const data = await sbSelect('info_toko', 'select=*&order=created_at.desc');
            return res.status(200).json({ data });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    // ── POST ─────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
        if (action === 'save_context') {
            try {
                const { kategori, judul, content } = req.body;
                const data = await sbInsert('info_toko', { kategori, judul, content });
                return res.status(200).json({ success: true, data });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        if (action === 'delete_context') {
            try {
                const { id } = req.body;
                await sbDelete('info_toko', `id=eq.${id}`);
                return res.status(200).json({ success: true });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        if (action === 'save_prompt') {
            try {
                const { prompt } = req.body;
                await sbUpsert('ai_config', { key: 'system_prompt', value: prompt }, 'key');
                return res.status(200).json({ success: true });
            } catch (e) { return res.status(500).json({ error: e.message }); }
        }

        // ── CHAT UTAMA ────────────────────────────────────────────────────
        try {
            const { user_message, user_image } = req.body;

            // Ambil knowledge + custom prompt paralel
            let knowledge = '', customPrompt = null;
            try {
                const [kRes, pRes] = await Promise.allSettled([
                    sbSelect('info_toko', 'select=judul,content&limit=20'),
                    sbSelect('ai_config', 'select=value&key=eq.system_prompt&limit=1')
                ]);
                if (kRes.status === 'fulfilled' && kRes.value?.length) {
                    knowledge = kRes.value.map(i => `${i.judul}: ${i.content}`).join('\n');
                }
                if (pRes.status === 'fulfilled' && pRes.value?.[0]?.value) {
                    customPrompt = pRes.value[0].value;
                }
            } catch (e) {
                console.error('[Supabase] fetch error:', e.message);
            }

            const systemPrompt = buildSystemPrompt(knowledge, customPrompt);

            // Fetch semua provider paralel
            const allResults = await fetchAllProviders(systemPrompt, user_message, user_image);
            const successful = allResults.filter(r => r.ok && r.text);
            const failed = allResults.filter(r => !r.ok);

            console.log(`[CHAT] OK: ${successful.map(r => r.provider + (r.realtime ? '(RT)' : '')).join(', ') || 'none'}`);
            if (failed.length) console.log(`[CHAT] FAIL: ${failed.map(r => `${r.provider}:${r.error?.slice(0,60)}`).join(', ')}`);

            if (!successful.length) {
                return res.status(500).json({
                    response: 'Semua AI provider lagi down bro, coba lagi bentar ya 🙏',
                    error: failed.map(r => `${r.provider}: ${r.error}`).join(' | ')
                });
            }

            const final = await synthesize(user_message, allResults);
            if (!final) return res.status(500).json({ response: 'Gagal generate jawaban bro, coba lagi.' });

            return res.status(200).json({
                response: final.text,
                sources: final.sources,
                providers_used: successful.map(r => r.provider + (r.realtime ? '[RT]' : '')),
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
