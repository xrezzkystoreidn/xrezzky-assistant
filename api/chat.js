// api/chat.js — Vercel Serverless
// Provider: Groq + OpenRouter (tanpa Gemini, tanpa Supabase)
// Env: GROQ_API_KEY_1..5, OPENROUTER_API_KEY_1..5

import { readFile } from 'fs/promises';
import { join } from 'path';

// ── Models ────────────────────────────────────────────────────────────────
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

// OpenRouter teks
const OR_TEXT = [
  'google/gemini-2.5-pro-preview',
  'anthropic/claude-3-haiku',
];

// OpenRouter vision (foto)
const OR_VISION = [
  'google/gemini-2.0-flash-001',
  'anthropic/claude-3-haiku',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
];

// ── Keys ──────────────────────────────────────────────────────────────────
function getKeys(prefix) {
  return [1,2,3,4,5]
    .map(i => process.env[`${prefix}_${i}`])
    .filter(Boolean);
}

// ── Prompt ────────────────────────────────────────────────────────────────
let _promptCache = null;
async function getPrompt() {
  if (_promptCache) return _promptCache;
  const base = join(process.cwd(), 'prompt');
  const files = ['prompt-persona.txt','prompt-aturan.txt','prompt-toko.txt'];
  const parts = [];
  for (const f of files) {
    try { parts.push((await readFile(join(base, f), 'utf-8')).trim()); } catch {}
  }
  const wib = new Date().toLocaleString('id-ID', { dateStyle:'full', timeStyle:'medium', timeZone:'Asia/Jakarta' });
  _promptCache = (parts.length ? parts.join('\n\n---\n\n') : 'Kamu adalah XREZZKY AI, asisten XREZZKY OFFICIAL STORE.') + `\n\nWaktu sekarang (WIB): ${wib}`;
  return _promptCache;
}

// ── Error helper ──────────────────────────────────────────────────────────
function isRateLimit(status, msg='') {
  return status===429 || /rate|quota|limit|exhausted|too.many/i.test(msg);
}

// ── GROQ ──────────────────────────────────────────────────────────────────
async function callGroq(key, model, sysprompt, msgs) {
  const body = {
    model,
    messages: [
      { role:'system', content: sysprompt },
      ...msgs.map(m => ({ role: m.role==='assistant'?'assistant':'user', content: m.content||'' }))
    ],
    max_tokens: 1024,
  };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) {
    let m = txt.slice(0,150); try { m=JSON.parse(txt)?.error?.message||m; } catch{}
    const e=new Error(m); e.status=r.status; e.limit=isRateLimit(r.status,m); throw e;
  }
  return JSON.parse(txt).choices[0].message.content;
}

// ── OPENROUTER ────────────────────────────────────────────────────────────
async function callOR(key, model, sysprompt, msgs, imageB64) {
  const hasImg = !!(imageB64?.includes(','));

  const history = msgs.slice(0,-1).map(m => ({
    role: m.role==='assistant'?'assistant':'user',
    content: m.content||''
  }));

  const lastText = msgs[msgs.length-1]?.content || '';
  let lastContent;
  if (hasImg) {
    const [meta, data] = imageB64.split(',');
    const mime = meta.match(/:(.*?);/)?.[1]||'image/jpeg';
    lastContent = [
      { type:'text', text: lastText||'Lihat dan ceritakan isi gambar ini.' },
      { type:'image_url', image_url:{ url:`data:${mime};base64,${data}` } },
    ];
  } else {
    lastContent = lastText||'Halo';
  }

  const body = {
    model,
    messages: [
      { role:'system', content: sysprompt },
      ...history,
      { role:'user', content: lastContent },
    ],
    max_tokens: 2048,
  };

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization':`Bearer ${key}`,
      'HTTP-Referer':'https://xrezzky-assistant.vercel.app',
      'X-Title':'XREZZKY OFFICIAL STORE',
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) {
    let m=txt.slice(0,150); try { m=JSON.parse(txt)?.error?.message||m; } catch{}
    const e=new Error(m); e.status=r.status; e.limit=isRateLimit(r.status,m); throw e;
  }
  const result = JSON.parse(txt).choices?.[0]?.message?.content;
  if (!result) throw new Error('Response kosong');
  return result;
}

// ── Try list helper ───────────────────────────────────────────────────────
// Coba semua kombinasi [key x model] sampai ada yang berhasil
async function tryList(keys, models, fn) {
  let lastErr;
  for (const key of keys) {
    for (const model of models) {
      try {
        const result = await fn(key, model);
        if (result) return { result, model };
      } catch(e) {
        lastErr = e;
        console.error(`[${model}]`, e.message?.slice(0,80));
        // kalau bukan rate limit, skip model ini untuk key ini
        if (!e.limit) break;
      }
    }
  }
  throw lastErr || new Error('Semua opsi gagal');
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({ error:'Method tidak diizinkan' });

  // Terima format lama (user_message) maupun baru (messages array)
  let { messages, user_message, user_image } = req.body||{};

  if (!messages?.length) {
    const text = user_message || null;
    const hasImg = !!(user_image?.includes(','));
    if (!text && !hasImg) return res.status(400).json({ error:'Kirim pesan atau foto dulu bro' });
    messages = [{ role:'user', content: text||'' }];
  }

  const hasImage = !!(user_image?.includes(','));
  const sysprompt = await getPrompt();
  const groqKeys = getKeys('GROQ_API_KEY');
  const orKeys   = getKeys('OPENROUTER_API_KEY');

  // Shuffle OR keys supaya load tersebar
  const orShuffled = [...orKeys].sort(()=>Math.random()-0.5);

  // ── Ada foto → langsung OpenRouter vision ────────────────────────────
  if (hasImage) {
    try {
      const { result, model } = await tryList(orShuffled, OR_VISION,
        (key, model) => callOR(key, model, sysprompt, messages, user_image)
      );
      return res.status(200).json({ response: result, provider:'openrouter', model });
    } catch(e) {
      return res.status(500).json({ response:'Maaf bro, gagal baca foto. Coba lagi.', error: e.message });
    }
  }

  // ── Teks → Groq dulu, fallback OpenRouter ────────────────────────────
  // Groq: coba semua key, tiap key coba model satu per satu
  if (groqKeys.length) {
    try {
      const { result, model } = await tryList(groqKeys, GROQ_MODELS,
        (key, model) => callGroq(key, model, sysprompt, messages)
      );
      return res.status(200).json({ response: result, provider:'groq', model });
    } catch(e) {
      console.error('[groq semua gagal]', e.message?.slice(0,80));
    }
  }

  // Fallback OpenRouter teks
  if (orShuffled.length) {
    try {
      const { result, model } = await tryList(orShuffled, OR_TEXT,
        (key, model) => callOR(key, model, sysprompt, messages, null)
      );
      return res.status(200).json({ response: result, provider:'openrouter', model });
    } catch(e) {
      return res.status(500).json({ response:'Semua AI provider lagi down bro, coba lagi bentar.', error: e.message });
    }
  }

  return res.status(500).json({ response:'Tidak ada API key yang tersedia.', error:'no keys' });
}
