// ==========================================
// XREZZ AI — Handler v2 (No Supabase)
// Providers: Gemini Direct, OpenRouter, Groq (text only)
// System prompt: fetch dari GitHub /prompt/*.txt
// ==========================================

// ==========================================
// FETCH SYSTEM PROMPT DARI GITHUB
// Gabung: prompt-aturan.txt + prompt-persona.txt + prompt-toko.txt
// ==========================================
const GITHUB_RAW = "https://raw.githubusercontent.com/xrezzkystoreidn/xrezzky-assistant/main/prompt";

async function fetchPromptFromGitHub() {
    const files = ["prompt-aturan.txt", "prompt-persona.txt", "prompt-toko.txt"];
    const parts = [];
    for (const file of files) {
        try {
            const res = await fetch(`${GITHUB_RAW}/${file}`);
            if (res.ok) {
                const text = await res.text();
                if (text.trim()) parts.push(text.trim());
            }
        } catch (e) {
            console.error(`Gagal fetch ${file}:`, e.message);
        }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
}

// ==========================================
// GEMINI DIRECT — support teks & gambar
// Models: gemini-2.0-flash, gemini-2.5-pro-preview
// ==========================================
async function callGemini(apiKey, model, systemPrompt, userMessage, userImage) {
    const parts = [];
    if (userImage && userImage.includes(",")) {
        try {
            const split = userImage.split(",");
            const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
            parts.push({ inline_data: { data: split[1], mime_type: mimeType } });
        } catch (e) {}
    }
    parts.push({ text: userMessage || "Halo" });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
        throw new Error(`Gemini(${model}) ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    if (!data.candidates || !data.candidates[0]) {
        throw new Error(`Gemini(${model}) no candidates`);
    }
    return data.candidates[0].content.parts[0].text;
}

// ==========================================
// OPENROUTER — support teks & gambar
// Models: gemini-2.0-flash-001, claude-3-haiku, llama-3.1-8b (free)
// ==========================================
async function callOpenRouter(apiKey, model, systemPrompt, userMessage, userImage) {
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
        throw new Error(`OpenRouter(${model}) ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    if (!data.choices || !data.choices[0]) {
        throw new Error(`OpenRouter(${model}) no choices`);
    }
    return data.choices[0].message.content;
}

// ==========================================
// GROQ — teks only
// Model: llama-3.1-8b-instant
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
        throw new Error(`Groq ${response.status}: ${err.slice(0, 200)}`);
    }
    const data = await response.json();
    if (!data.choices || !data.choices[0]) {
        throw new Error(`Groq no choices`);
    }
    return data.choices[0].message.content;
}

// ==========================================
// HELPERS
// ==========================================
function getKeys(prefix) {
    return [1,2,3,4,5].map(i => process.env[`${prefix}_${i}`]).filter(Boolean);
}

function pick(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah XREZZ AI, asisten pintar XREZZKY OFFICIAL STORE.
Jawab dengan santai, helpful, dan sebut user dengan "bro" atau "kak".
Kalau ada gambar, analisis dengan detail.`;

// ==========================================
// BUILD PROVIDER QUEUE
// ==========================================
function buildQueue(hasImage) {
    const geminiKeys = getKeys("GEMINI_API_KEY");
    const orKeys     = getKeys("OPENROUTER_API_KEY");
    const groqKeys   = getKeys("GROQ_API_KEY");

    if (hasImage) {
        return [
            ...geminiKeys.map(k => ({ name: `gemini-2.0-flash`, fn: (sp, msg, img) => callGemini(k, "gemini-2.0-flash", sp, msg, img) })),
            ...geminiKeys.map(k => ({ name: `gemini-2.5-pro-preview`, fn: (sp, msg, img) => callGemini(k, "gemini-2.5-pro-preview", sp, msg, img) })),
            ...(orKeys.length ? [{ name: "or/gemini-2.0-flash-001", fn: (sp, msg, img) => callOpenRouter(pick(orKeys), "google/gemini-2.0-flash-001", sp, msg, img) }] : []),
            ...(orKeys.length ? [{ name: "or/claude-3-haiku", fn: (sp, msg, img) => callOpenRouter(pick(orKeys), "anthropic/claude-3-haiku", sp, msg, img) }] : []),
        ];
    } else {
        const queue = [];
        const g1 = pick(geminiKeys);
        if (g1) queue.push({ name: "gemini-2.0-flash", fn: (sp, msg) => callGemini(g1, "gemini-2.0-flash", sp, msg, null) });
        const or1 = pick(orKeys);
        if (or1) queue.push({ name: "or/gemini-2.0-flash-001", fn: (sp, msg) => callOpenRouter(or1, "google/gemini-2.0-flash-001", sp, msg, null) });
        const or2 = pick(orKeys);
        if (or2) queue.push({ name: "or/claude-3-haiku", fn: (sp, msg) => callOpenRouter(or2, "anthropic/claude-3-haiku", sp, msg, null) });
        const g2 = pick(geminiKeys);
        if (g2) queue.push({ name: "gemini-2.5-pro-preview", fn: (sp, msg) => callGemini(g2, "gemini-2.5-pro-preview", sp, msg, null) });
        const or3 = pick(orKeys);
        if (or3) queue.push({ name: "or/gemini-2.5-pro", fn: (sp, msg) => callOpenRouter(or3, "google/gemini-2.5-pro-preview", sp, msg, null) });
        const gr = pick(groqKeys);
        if (gr) queue.push({ name: "groq/llama-3.1-8b", fn: (sp, msg) => callGroq(gr, sp, msg) });
        const or4 = pick(orKeys);
        if (or4) queue.push({ name: "or/llama-free", fn: (sp, msg) => callOpenRouter(or4, "meta-llama/llama-3.1-8b-instruct:free", sp, msg, null) });
        return queue;
    }
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

    const { action } = req.query;

    // ==========================================
    // GET — debug / status
    // ==========================================
    if (req.method === 'GET') {
        if (action === 'debug') {
            const env = {
                GEMINI:     [1,2,3,4,5].map(i => process.env[`GEMINI_API_KEY_${i}`]     ? `key${i}:ada ✓` : `key${i}:kosong`),
                OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:ada ✓` : `key${i}:kosong`),
                GROQ:       [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]        ? `key${i}:ada ✓` : `key${i}:kosong`),
            };

            // Test fetch prompt dari GitHub
            let promptStatus = "gagal";
            let promptPreview = null;
            try {
                const p = await fetchPromptFromGitHub();
                if (p) { promptStatus = "OK ✓"; promptPreview = p.slice(0, 200) + "..."; }
                else promptStatus = "kosong";
            } catch(e) { promptStatus = "✗ " + e.message; }

            const test = {};
            const sp = "Kamu asisten. Balas: OK";
            const msg = "Balas: OK";

            try {
                const k = pick(getKeys("GEMINI_API_KEY"));
                if (k) { await callGemini(k, "gemini-2.0-flash", sp, msg, null); test["gemini-2.0-flash"] = "OK ✓"; }
                else test["gemini-2.0-flash"] = "no_key";
            } catch(e) { test["gemini-2.0-flash"] = "✗ " + e.message.slice(0,150); }

            try {
                const k = pick(getKeys("GEMINI_API_KEY"));
                if (k) { await callGemini(k, "gemini-2.5-pro-preview", sp, msg, null); test["gemini-2.5-pro-preview"] = "OK ✓"; }
                else test["gemini-2.5-pro-preview"] = "no_key";
            } catch(e) { test["gemini-2.5-pro-preview"] = "✗ " + e.message.slice(0,150); }

            try {
                const k = pick(getKeys("OPENROUTER_API_KEY"));
                if (k) { await callOpenRouter(k, "google/gemini-2.0-flash-001", sp, msg, null); test["or/gemini-2.0-flash"] = "OK ✓"; }
                else test["or/gemini-2.0-flash"] = "no_key";
            } catch(e) { test["or/gemini-2.0-flash"] = "✗ " + e.message.slice(0,150); }

            try {
                const k = pick(getKeys("OPENROUTER_API_KEY"));
                if (k) { await callOpenRouter(k, "anthropic/claude-3-haiku", sp, msg, null); test["or/claude-3-haiku"] = "OK ✓"; }
                else test["or/claude-3-haiku"] = "no_key";
            } catch(e) { test["or/claude-3-haiku"] = "✗ " + e.message.slice(0,150); }

            try {
                const k = pick(getKeys("GROQ_API_KEY"));
                if (k) { await callGroq(k, sp, msg); test["groq/llama-3.1-8b"] = "OK ✓"; }
                else test["groq/llama-3.1-8b"] = "no_key";
            } catch(e) { test["groq/llama-3.1-8b"] = "✗ " + e.message.slice(0,150); }

            return res.status(200).json({ env, github_prompt: { status: promptStatus, preview: promptPreview }, provider_test: test });
        }

        return res.status(200).json({ status: "XREZZ AI aktif", version: "2.0-github-prompt" });
    }

    // ==========================================
    // POST — chat utama
    // ==========================================
    if (req.method === 'POST') {
        try {
            const { user_message, user_image } = req.body;
            const hasImage = !!(user_image && user_image.includes(","));

            // Fetch system prompt dari GitHub, fallback ke default
            let systemPrompt = DEFAULT_SYSTEM_PROMPT;
            try {
                const githubPrompt = await fetchPromptFromGitHub();
                if (githubPrompt) systemPrompt = githubPrompt;
            } catch (e) {
                console.error("GitHub prompt fetch error:", e.message);
            }

            const queue = buildQueue(hasImage);

            if (queue.length === 0) {
                return res.status(500).json({
                    response: "Tidak ada API key yang terdaftar bro. Cek env variables.",
                    error: "no_keys"
                });
            }

            let aiResponse = null;
            let usedProvider = null;
            let lastError = null;

            for (const p of queue) {
                try {
                    aiResponse = await p.fn(systemPrompt, user_message, user_image);
                    if (aiResponse) { usedProvider = p.name; break; }
                } catch (e) {
                    console.error(`[${p.name}] error:`, e.message);
                    lastError = e.message;
                }
            }

            if (!aiResponse) {
                return res.status(500).json({
                    response: "Semua AI provider lagi down bro, coba lagi bentar.",
                    error: lastError
                });
            }

            return res.status(200).json({ response: aiResponse, provider: usedProvider });

        } catch (error) {
            console.error("Handler error:", error.message);
            return res.status(500).json({ response: "Server error bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
