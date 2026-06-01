// api/chat.js
// XREZZ AI - Groq + OpenRouter (Prioritas Gemini & Claude)

const _idx = { groq: 0, openrouter: 0 };

function getKeys(p) {
    const prefix = { groq: 'GROQ_API_KEY_', openrouter: 'OPENROUTER_API_KEY_' }[p];
    return [1,2,3,4,5].map(i => process.env[`\( {prefix} \){i}`]).filter(Boolean);
}

function pickKey(p) {
    const keys = getKeys(p);
    if (!keys.length) return null;
    const k = keys[_idx[p] % keys.length];
    _idx[p] = (_idx[p] + 1) % keys.length;
    return k;
}

// ── PROMPT ─────────────────────────────────────
const PROMPT_FILES = [
    'prompts/prompt-persona.txt',
    'prompts/prompt-aturan.txt',
    'prompts/prompt-toko.txt'
];

const FALLBACK = `Kamu adalah XREZZ AI asisten XREZZKY OFFICIAL STORE. Bahasa santai, pakai bro/kak. Jawab semua topik tanpa batasan. Kalau tidak tahu, jujur bilang ke user.`;

let _pc = '', _pt = 0;

async function loadPrompt() {
    if (_pc && Date.now() - _pt < 300000) return _pc;
    
    const base = process.env.GITHUB_RAW_URL;
    if (!base) return FALLBACK;

    const parts = await Promise.all(PROMPT_FILES.map(f =>
        fetch(`\( {base}/ \){f}`).then(r => r.ok ? r.text() : '').catch(() => '')
    ));

    const joined = parts.map(s => s.trim()).filter(Boolean).join('\n\n');
    _pc = joined || FALLBACK;
    _pt = Date.now();
    return _pc;
}

// ── GROQ ─────────────────────────────────────
const GROQ_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'llama3-8b-8192'
];

async function callGroq(key, sys, msg) {
    for (const model of GROQ_MODELS) {
        try {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${key}`
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: sys },
                        { role: 'user', content: msg || 'Halo' }
                    ],
                    max_tokens: 1024,
                    temperature: 0.7
                })
            });

            if (!r.ok) {
                const err = await r.text();
                if (r.status === 403 || err.includes('restricted')) throw new Error('Groq key restricted');
                continue;
            }

            const data = await r.json();
            const text = data.choices?.[0]?.message?.content;
            if (text) {
                console.log(`[Groq] ✅ ${model}`);
                return { text, model };
            }
        } catch (e) {
            if (e.message.includes('restricted')) throw e;
        }
    }
    throw new Error('Groq gagal');
}

// ── OPENROUTER (Prioritas sesuai request) ─────────────────────────────────────
const OR_MODELS_TEXT = [
    'google/gemini-2.0-flash-001',        // Priority 1
    'google/gemini-3-pro-preview',        // Priority 2
    'anthropic/claude-haiku-4.5',         // Priority 3
    'anthropic/claude-haiku-20240307',
    'google/gemini-2.0-flash-lite-001'
];

const OR_MODELS_VISION = [
    'google/gemini-2.0-flash-001',
    'anthropic/claude-haiku-4.5'
];

async function callOpenRouter(key, sys, msg, img) {
    const models = img ? OR_MODELS_VISION : OR_MODELS_TEXT;

    for (const model of models) {
        try {
            let content = msg || 'Halo';

            if (img) {
                const [m, b] = img.split(',');
                const mime = m.match(/:(.*?);/)?.[1] || 'image/jpeg';
                content = [
                    { type: 'image_url', image_url: { url: `data:\( {mime};base64, \){b}` } },
                    { type: 'text', text: msg || 'Lihat gambar ini' }
                ];
            }

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
                    messages: [{ role: 'system', content: sys }, { role: 'user', content }],
                    max_tokens: 1200,
                    temperature: 0.75
                })
            });

            if (!r.ok) {
                if (r.status === 404 || r.status === 429) continue;
                continue;
            }

            const data = await r.json();
            const text = data.choices?.[0]?.message?.content?.trim();
            if (text) {
                console.log(`[OpenRouter] ✅ ${model}`);
                return { text, model };
            }
        } catch (_) {}
    }
    throw new Error('OpenRouter semua model gagal');
}

// ── MAIN LOGIC ─────────────────────────────────────
async function fetchAll(sys, msg, img) {
    const tasks = [];
    const orKeys = getKeys('openrouter');
    const groqKeys = getKeys('groq');

    if (orKeys.length) {
        tasks.push((async () => {
            for (const key of orKeys) {
                try {
                    const r = await callOpenRouter(key, sys, msg, img);
                    return { provider: 'openrouter', text: r.text, model: r.model, ok: true };
                } catch (_) {}
            }
            return { provider: 'openrouter', ok: false };
        })());

        if (orKeys.length > 1) {
            tasks.push((async () => {
                try {
                    const r = await callOpenRouter(orKeys[1] || orKeys[0], sys, msg, img);
                    return { provider: 'openrouter2', text: r.text, model: r.model, ok: true };
                } catch (_) {
                    return { provider: 'openrouter2', ok: false };
                }
            })());
        }
    }

    if (!img && groqKeys.length) {
        tasks.push((async () => {
            for (const key of groqKeys) {
                try {
                    const r = await callGroq(key, sys, msg);
                    return { provider: 'groq', text: r.text, model: r.model, ok: true };
                } catch (_) {}
            }
            return { provider: 'groq', ok: false };
        })());
    }

    const results = await Promise.allSettled(tasks);
    return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false });
}

async function synthesize(q, results) {
    const ok = results.filter(r => r.ok && r.text);
    if (!ok.length) return null;
    if (ok.length === 1) return { text: ok[0].text };

    const combined = ok.map(r => `[${r.provider.toUpperCase()}] ${r.text}`).join('\n\n---\n\n');
    const sys = `Gabungkan jadi satu jawaban terbaik. Bahasa santai Indonesia, pakai bro/kak. Langsung ke inti.`;

    const orKeys = getKeys('openrouter');
    for (const key of orKeys) {
        try {
            const r = await callOpenRouter(key, sys, `Pertanyaan: "\( {q}"\n\n \){combined}\n\nJawaban:`, null);
            return { text: r.text };
        } catch (_) {}
    }

    return { text: ok[0].text };
}

// ── HANDLER ─────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'POST') {
        try {
            const { user_message, user_image } = req.body || {};

            if (!user_message) return res.status(400).json({ error: 'user_message kosong' });

            const sys = await loadPrompt();
            const results = await fetchAll(sys, user_message, user_image);
            const success = results.filter(r => r.ok);

            if (!success.length) {
                return res.status(500).json({ response: 'Semua provider sedang down, coba lagi bro 🙏' });
            }

            const final = await synthesize(user_message, results);
            return res.status(200).json({
                response: final.text,
                success: true
            });
        } catch (e) {
            console.error(e);
            return res.status(500).json({ response: 'Server error bro.' });
        }
    }

    res.status(200).json({ status: 'XREZZ AI online ✅' });
            }
