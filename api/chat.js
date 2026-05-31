// chat.js — NO supabase, NO imports, pure fetch only

// ── KEY ROTATION ─────────────────────────────────────────────────────────────
const _idx = { gemini: 0, groq: 0, openrouter: 0 };
function getKeys(p) {
    const prefix = { gemini:'GEMINI_API_KEY_', groq:'GROQ_API_KEY_', openrouter:'OPENROUTER_API_KEY_' }[p];
    return [1,2,3,4,5].map(i => process.env[`${prefix}${i}`]).filter(Boolean);
}
function pickKey(p) {
    const keys = getKeys(p);
    if (!keys.length) return null;
    const k = keys[_idx[p] % keys.length];
    _idx[p] = (_idx[p] + 1) % keys.length;
    return k;
}

// ── SYSTEM PROMPT — dari GitHub, cache 5 menit ───────────────────────────────
const PROMPT_FILES = ['prompts/prompt-persona.txt','prompts/prompt-aturan.txt','prompts/prompt-toko.txt'];
const FALLBACK_PROMPT = `Kamu adalah XREZZ AI asisten XREZZKY OFFICIAL STORE. Bahasa santai, pakai bro/kak. Jawab semua topik. Gunakan hasil search untuk info akurat dan terkini. Kalau tidak tahu, jujur bilang ke user.`;
let _promptCache = '', _promptTime = 0;

async function loadPrompt() {
    if (_promptCache && Date.now() - _promptTime < 300000) return _promptCache;
    const base = process.env.GITHUB_RAW_URL;
    if (!base) return FALLBACK_PROMPT;
    const parts = await Promise.all(
        PROMPT_FILES.map(f =>
            fetch(`${base}/${f}`).then(r => r.ok ? r.text() : '').catch(() => '')
        )
    );
    const joined = parts.map(s => s.trim()).filter(Boolean).join('\n\n');
    if (!joined) return FALLBACK_PROMPT;
    _promptCache = joined;
    _promptTime  = Date.now();
    return _promptCache;
}

// ── GEMINI ───────────────────────────────────────────────────────────────────
async function callGemini(key, sys, msg, img, search) {
    const parts = [];
    if (img) {
        try { const [m,b] = img.split(','); parts.push({ inline_data:{ data:b, mime_type:m.match(/:(.*?);/)?.[1]||'image/jpeg' } }); } catch(_){}
    }
    parts.push({ text: msg||'Halo' });
    const body = {
        system_instruction: { parts:[{ text:sys }] },
        contents: [{ role:'user', parts }],
        generationConfig: { maxOutputTokens:1024, temperature:0.7 }
    };
    if (search) body.tools = [{ google_search:{} }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0,150)}`);
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini empty');
    const sources = (d.candidates?.[0]?.groundingMetadata?.groundingChunks||[]).map(c=>c.web?.uri).filter(Boolean).slice(0,3);
    return { text, sources };
}

// ── GROQ ─────────────────────────────────────────────────────────────────────
async function callGroq(key, sys, msg) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`},
        body:JSON.stringify({ model:'llama-3.1-8b-instant', messages:[{role:'system',content:sys},{role:'user',content:msg||'Halo'}], max_tokens:1024, temperature:0.7 })
    });
    if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0,150)}`);
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq empty');
    return { text, sources:[] };
}

// ── OPENROUTER ───────────────────────────────────────────────────────────────
async function callOpenRouter(key, sys, msg, img) {
    let content = msg||'Halo';
    if (img) {
        try { const [m,b] = img.split(','); content = [{ type:'image_url', image_url:{ url:`data:${m.match(/:(.*?);/)?.[1]||'image/jpeg'};base64,${b}` }},{ type:'text', text:msg||'Lihat gambar' }]; } catch(_){}
    }
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`, 'HTTP-Referer':'https://xrezzky-assistant.vercel.app', 'X-Title':'XREZZKY OFFICIAL STORE'},
        body:JSON.stringify({ model: img?'google/gemini-2.0-flash-001':'meta-llama/llama-3.1-8b-instruct:free', messages:[{role:'system',content:sys},{role:'user',content}], max_tokens:1024 })
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0,150)}`);
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenRouter empty');
    return { text, sources:[] };
}

// ── NEED SEARCH ──────────────────────────────────────────────────────────────
function needsSearch(msg) {
    if (!msg) return false;
    const l = msg.toLowerCase();
    if (['halo','hai','hi','oke','ok','sip','makasih','thanks','bye'].includes(l.trim())) return false;
    return ['?','apa','siapa','dimana','kapan','kenapa','bagaimana','gimana','berapa','cari','berita','info',
        'terbaru','terkini','sekarang','hari ini','harga','cuaca','trending','viral','news','today','cara','jelaskan'].some(k=>l.includes(k));
}

// ── FETCH ALL PARALLEL ───────────────────────────────────────────────────────
async function fetchAll(sys, msg, img) {
    const search = needsSearch(msg);
    const tasks  = [];

    const gk = pickKey('gemini');
    if (gk) tasks.push(
        callGemini(gk, sys, msg, img, search)
            .then(r=>({ provider:'gemini', text:r.text, sources:r.sources, ok:true, rt:search }))
            .catch(async e => {
                const k2 = pickKey('gemini');
                if (!k2) return { provider:'gemini', ok:false, error:e.message };
                return callGemini(k2, sys, msg, img, false)
                    .then(r=>({ provider:'gemini', text:r.text, sources:[], ok:true, rt:false }))
                    .catch(e2=>({ provider:'gemini', ok:false, error:e2.message }));
            })
    );

    if (!img) {
        const grk = pickKey('groq');
        if (grk) tasks.push(
            callGroq(grk, sys, msg)
                .then(r=>({ provider:'groq', text:r.text, sources:[], ok:true }))
                .catch(async e => {
                    const k2 = pickKey('groq');
                    if (!k2) return { provider:'groq', ok:false, error:e.message };
                    return callGroq(k2, sys, msg)
                        .then(r=>({ provider:'groq', text:r.text, sources:[], ok:true }))
                        .catch(e2=>({ provider:'groq', ok:false, error:e2.message }));
                })
        );
    }

    const ok2 = pickKey('openrouter');
    if (ok2) tasks.push(
        callOpenRouter(ok2, sys, msg, img)
            .then(r=>({ provider:'openrouter', text:r.text, sources:[], ok:true }))
            .catch(async e => {
                const k2 = pickKey('openrouter');
                if (!k2) return { provider:'openrouter', ok:false, error:e.message };
                return callOpenRouter(k2, sys, msg, img)
                    .then(r=>({ provider:'openrouter', text:r.text, sources:[], ok:true }))
                    .catch(e2=>({ provider:'openrouter', ok:false, error:e2.message }));
            })
    );

    const s = await Promise.allSettled(tasks);
    return s.map(r => r.status==='fulfilled' ? r.value : { provider:'unknown', ok:false, error:r.reason?.message });
}

// ── SYNTHESIZE ───────────────────────────────────────────────────────────────
async function synthesize(q, results) {
    const ok = results.filter(r=>r.ok&&r.text);
    if (!ok.length) return null;
    if (ok.length===1) return { text:ok[0].text, sources:ok[0].sources||[] };
    const combined = ok.map(r=>`[${r.provider.toUpperCase()}${r.rt?' ★RT':''}]\n${r.text}`).join('\n\n---\n\n');
    const sys = `Gabungkan jawaban berikut jadi SATU jawaban terbaik. ★RT = prioritas. Jangan sebut nama provider. Bahasa santai bro/kak. Format rapi.`;
    const gk = pickKey('gemini');
    const best = () => { const b = ok.find(r=>r.rt)||ok.reduce((a,b)=>a.text.length>=b.text.length?a:b); return { text:b.text, sources:b.sources||[] }; };
    if (!gk) return best();
    try {
        const r = await callGemini(gk, sys, `Q: "${q}"\n\n${combined}\n\nJawaban terbaik:`, null, false);
        return { text:r.text, sources:[...new Set(ok.flatMap(r=>r.sources||[]))] };
    } catch(e) { return best(); }
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method==='OPTIONS') return res.status(200).end();

    if (req.method==='GET') {
        if (req.query.action==='debug') {
            const s = {};
            await Promise.allSettled([
                (async()=>{ const k=pickKey('gemini');     if(!k){s.gemini='no_key';return;}     await callGemini(k,'A','OK',null,false); s.gemini='OK ✓'; })().catch(e=>{s.gemini='✗ '+e.message.slice(0,80);}),
                (async()=>{ const k=pickKey('groq');       if(!k){s.groq='no_key';return;}       await callGroq(k,'A','OK');             s.groq='OK ✓';   })().catch(e=>{s.groq='✗ '+e.message.slice(0,80);}),
                (async()=>{ const k=pickKey('openrouter'); if(!k){s.openrouter='no_key';return;} await callOpenRouter(k,'A','OK',null);  s.openrouter='OK ✓'; })().catch(e=>{s.openrouter='✗ '+e.message.slice(0,80);}),
            ]);
            const prompt = await loadPrompt();
            return res.status(200).json({ providers:s, keys:{ gemini:getKeys('gemini').length, groq:getKeys('groq').length, openrouter:getKeys('openrouter').length }, prompt_ok: prompt.length>50 });
        }
        return res.status(200).json({ status:'XREZZ AI online ✓' });
    }

    if (req.method==='POST') {
        try {
            const { user_message, user_image } = req.body||{};
            if (!user_message && !user_image) return res.status(400).json({ error:'user_message kosong' });

            const sys      = await loadPrompt();
            const results  = await fetchAll(sys, user_message, user_image||null);
            const success  = results.filter(r=>r.ok&&r.text);
            const fail     = results.filter(r=>!r.ok);

            console.log(`[CHAT] OK:${success.map(r=>r.provider+(r.rt?'(RT)':'')).join(',')||'none'} FAIL:${fail.map(r=>r.provider).join(',')||'none'}`);

            if (!success.length) return res.status(500).json({ response:'Semua AI provider down bro, coba lagi 🙏', error: fail.map(r=>`${r.provider}:${r.error}`).join('|') });

            const final = await synthesize(user_message, results);
            if (!final) return res.status(500).json({ response:'Gagal generate jawaban bro.' });

            return res.status(200).json({
                response: final.text,
                sources:  final.sources,
                providers_used:   success.map(r=>r.provider+(r.rt?'[RT]':'')),
                providers_failed: fail.map(r=>r.provider),
                synthesized: success.length>1,
                realtime: success.some(r=>r.rt)
            });
        } catch(e) {
            console.error('[Handler]',e.message);
            return res.status(500).json({ response:'Server error bro.', error:e.message });
        }
    }

    return res.status(405).json({ error:'Method not allowed' });
}
