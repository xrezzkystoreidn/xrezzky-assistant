// chat.js — Groq + OpenRouter only, zero imports

// ── KEY ROTATION ─────────────────────────────────────────────────────────────
const _idx = { groq: 0, openrouter: 0 };
function getKeys(p) {
    const prefix = { groq:'GROQ_API_KEY_', openrouter:'OPENROUTER_API_KEY_' }[p];
    return [1,2,3,4,5].map(i => process.env[`${prefix}${i}`]).filter(Boolean);
}
function pickKey(p) {
    const keys = getKeys(p);
    if (!keys.length) return null;
    const k = keys[_idx[p] % keys.length];
    _idx[p] = (_idx[p] + 1) % keys.length;
    return k;
}

// ── PROMPT — GitHub cache 5 menit ────────────────────────────────────────────
const PROMPT_FILES = ['prompts/prompt-persona.txt','prompts/prompt-aturan.txt','prompts/prompt-toko.txt'];
const FALLBACK = `Kamu adalah XREZZ AI asisten XREZZKY OFFICIAL STORE. Bahasa santai, pakai bro/kak. Jawab semua topik tanpa batasan. Kalau tidak tahu, jujur bilang ke user.`;
let _pc = '', _pt = 0;
async function loadPrompt() {
    if (_pc && Date.now() - _pt < 300000) return _pc;
    const base = process.env.GITHUB_RAW_URL;
    if (!base) return FALLBACK;
    const parts = await Promise.all(PROMPT_FILES.map(f =>
        fetch(`${base}/${f}`).then(r => r.ok ? r.text() : '').catch(() => '')
    ));
    const joined = parts.map(s => s.trim()).filter(Boolean).join('\n\n');
    if (!joined) return FALLBACK;
    _pc = joined; _pt = Date.now();
    return _pc;
}

// ── GROQ ─────────────────────────────────────────────────────────────────────
const GROQ_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'llama3-8b-8192',
    'mixtral-8x7b-32768',
    'gemma2-9b-it'
];
async function callGroq(key, sys, msg) {
    let lastErr;
    for (const model of GROQ_MODELS) {
        try {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
                body: JSON.stringify({
                    model,
                    messages: [{ role:'system', content:sys }, { role:'user', content:msg||'Halo' }],
                    max_tokens: 1024, temperature: 0.7
                })
            });
            if (!r.ok) {
                const err = await r.text();
                if (r.status===403 || err.includes('restricted') || err.includes('deactivated')) {
                    throw new Error(`Groq key restricted`); // langsung bubble, jangan coba model lain
                }
                lastErr = `Groq ${r.status} [${model}]: ${err.slice(0,80)}`;
                continue;
            }
            const d = await r.json();
            const text = d.choices?.[0]?.message?.content;
            if (!text) { lastErr = `Groq empty [${model}]`; continue; }
            console.log(`[Groq] OK model: ${model}`);
            return { text, model };
        } catch(e) {
            if (e.message.includes('restricted')) throw e;
            lastErr = e.message;
        }
    }
    throw new Error(lastErr || 'Groq semua model gagal');
}

// ── OPENROUTER ───────────────────────────────────────────────────────────────
// Model prioritas: Gemini Flash → Gemini Pro → Claude Haiku → fallback gratis
const OR_MODELS_TEXT = [
    'google/gemini-2.0-flash-001',
    'google/gemini-pro',
    'anthropic/claude-haiku-20240307',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen3-8b:free',
];
const OR_MODELS_VISION = [
    'google/gemini-2.0-flash-001',
    'anthropic/claude-haiku-20240307',
];

async function callOpenRouter(key, sys, msg, img) {
    const models = img ? OR_MODELS_VISION : OR_MODELS_TEXT;
    let lastErr;

    for (const model of models) {
        let content = msg || 'Halo';
        if (img) {
            try {
                const [m, b] = img.split(',');
                const mime = m.match(/:(.*?);/)?.[1] || 'image/jpeg';
                content = [
                    { type:'image_url', image_url:{ url:`data:${mime};base64,${b}` } },
                    { type:'text', text: msg||'Lihat gambar ini' }
                ];
            } catch(_) {}
        }

        try {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${key}`,
                    'HTTP-Referer': 'https://xrezzky-assistant.vercel.app',
                    'X-Title': 'XREZZKY OFFICIAL STORE'
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role:'system', content:sys }, { role:'user', content }],
                    max_tokens: 1024
                })
            });
            if (!r.ok) {
                lastErr = `OR ${r.status} [${model}]: ${(await r.text()).slice(0,80)}`;
                continue;
            }
            const d = await r.json();
            const text = d.choices?.[0]?.message?.content;
            if (!text) { lastErr = `OR empty [${model}]`; continue; }
            console.log(`[OpenRouter] OK model: ${model}`);
            return { text, model };
        } catch(e) {
            lastErr = e.message;
        }
    }
    throw new Error(lastErr || 'OpenRouter semua model gagal');
}

// ── NEED SEARCH ──────────────────────────────────────────────────────────────
function needsSearch(msg) {
    if (!msg) return false;
    const l = msg.toLowerCase().trim();
    if (['halo','hai','hi','oke','ok','sip','makasih','thanks','bye'].includes(l)) return false;
    return ['?','apa','siapa','dimana','kapan','kenapa','bagaimana','gimana','berapa','cari',
        'berita','info','terbaru','terkini','sekarang','hari ini','harga','cuaca','trending',
        'viral','news','today','cara','jelaskan','tutorial'].some(k => l.includes(k));
}

// ── FETCH ALL PARALLEL ───────────────────────────────────────────────────────
async function fetchAll(sys, msg, img) {
    const tasks = [];
    const orKeys  = getKeys('openrouter');
    const groqKeys = getKeys('groq');

    // OpenRouter — coba tiap key sampai berhasil
    if (orKeys.length) {
        const tryOR = async () => {
            let lastErr;
            for (const key of orKeys) {
                try {
                    const r = await callOpenRouter(key, sys, msg, img);
                    return { provider:'openrouter', text:r.text, model:r.model, ok:true };
                } catch(e) { lastErr = e.message; }
            }
            return { provider:'openrouter', ok:false, error:lastErr };
        };
        // Jalankan 2 request OR paralel (key berbeda, model berbeda bisa saling backup)
        tasks.push(tryOR());
        if (orKeys.length > 1) {
            tasks.push(
                // Request kedua: skip key pertama, mulai dari key ke-2
                (async () => {
                    const key = orKeys[1] || orKeys[0];
                    try {
                        const r = await callOpenRouter(key, sys, msg, img);
                        return { provider:'openrouter2', text:r.text, model:r.model, ok:true };
                    } catch(e) {
                        return { provider:'openrouter2', ok:false, error:e.message };
                    }
                })()
            );
        }
    }

    // Groq — skip kalau ada gambar
    if (!img && groqKeys.length) {
        const tryGroq = async () => {
            let lastErr;
            for (const key of groqKeys) {
                try {
                    const r = await callGroq(key, sys, msg);
                    return { provider:'groq', text:r.text, model:r.model, ok:true };
                } catch(e) {
                    lastErr = e.message;
                    if (e.message.includes('restricted')) break;
                }
            }
            return { provider:'groq', ok:false, error:lastErr };
        };
        tasks.push(tryGroq());
    }

    const settled = await Promise.allSettled(tasks);
    return settled.map(r => r.status==='fulfilled' ? r.value : { provider:'unknown', ok:false, error:r.reason?.message });
}

// ── SYNTHESIZE — pakai OpenRouter (Claude/Gemini) ────────────────────────────
async function synthesize(q, results) {
    const ok = results.filter(r => r.ok && r.text);
    if (!ok.length) return null;
    if (ok.length === 1) return { text: ok[0].text };

    const combined = ok.map(r => `[${r.provider.toUpperCase()} - ${r.model||''}]\n${r.text}`).join('\n\n---\n\n');
    const sys = `Gabungkan jawaban-jawaban berikut jadi SATU jawaban terbaik dan paling akurat. Jangan sebut nama provider atau model. Bahasa santai Indonesia, pakai bro/kak. Format rapi, langsung ke inti.`;

    // Pakai OpenRouter key pertama yang tersedia untuk synthesis
    const orKeys = getKeys('openrouter');
    for (const key of orKeys) {
        try {
            const r = await callOpenRouter(key, sys, `Pertanyaan: "${q}"\n\n${combined}\n\nJawaban terbaik:`, null);
            return { text: r.text };
        } catch(e) { continue; }
    }

    // Fallback: pilih jawaban terpanjang
    const best = ok.reduce((a, b) => a.text.length >= b.text.length ? a : b);
    return { text: best.text };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'GET') {
        if (req.query.action === 'debug') {
            const s = {};
            await Promise.allSettled([
                (async () => {
                    const k = pickKey('groq');
                    if (!k) { s.groq = 'no_key'; return; }
                    await callGroq(k, 'Asisten.', 'Balas OK saja');
                    s.groq = 'OK ✓';
                })().catch(e => { s.groq = '✗ ' + e.message.slice(0,100); }),
                (async () => {
                    const k = pickKey('openrouter');
                    if (!k) { s.openrouter = 'no_key'; return; }
                    await callOpenRouter(k, 'Asisten.', 'Balas OK saja', null);
                    s.openrouter = 'OK ✓';
                })().catch(e => { s.openrouter = '✗ ' + e.message.slice(0,100); }),
            ]);
            return res.status(200).json({
                providers: s,
                keys: { groq: getKeys('groq').length, openrouter: getKeys('openrouter').length },
                models: { groq: GROQ_MODELS, openrouter: OR_MODELS_TEXT }
            });
        }
        return res.status(200).json({ status: 'XREZZ AI online ✓' });
    }

    if (req.method === 'POST') {
        try {
            const { user_message, user_image } = req.body || {};
            if (!user_message && !user_image) return res.status(400).json({ error: 'user_message kosong' });

            const sys     = await loadPrompt();
            const results = await fetchAll(sys, user_message, user_image || null);
            const success = results.filter(r => r.ok && r.text);
            const fail    = results.filter(r => !r.ok);

            console.log(`[CHAT] OK:${success.map(r=>`${r.provider}(${r.model})`).join(',')||'none'} FAIL:${fail.map(r=>`${r.provider}:${r.error?.slice(0,40)}`).join(',')||'none'}`);

            if (!success.length) return res.status(500).json({
                response: 'Semua AI provider down bro, coba lagi 🙏',
                error: fail.map(r => `${r.provider}: ${r.error}`).join(' | ')
            });

            const final = await synthesize(user_message, results);
            if (!final) return res.status(500).json({ response: 'Gagal generate jawaban bro.' });

            return res.status(200).json({
                response: final.text,
                providers_used:   success.map(r => `${r.provider}(${r.model})`),
                providers_failed: fail.map(r => r.provider),
                synthesized: success.length > 1
            });
        } catch(e) {
            console.error('[Handler]', e.message);
            return res.status(500).json({ response: 'Server error bro.', error: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
