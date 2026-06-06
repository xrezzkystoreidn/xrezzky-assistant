// api/chat.js — Vercel Serverless
// Auto-scan model tiap 1 jam, pakai yang bisa saja
// Provider: OpenRouter (utama) + Groq (teks)
// Env: GROQ_API_KEY_1..5, OPENROUTER_API_KEY_1..5

import { readFile } from 'fs/promises';
import { join } from 'path';

// ══════════════════════════════════════════════════════════════════════════
// SEMUA MODEL YANG AKAN DI-SCAN
// ══════════════════════════════════════════════════════════════════════════
const OR_ALL_MODELS = [
  { id: 'google/gemini-2.0-flash-001',       vision: true  },
  { id: 'google/gemini-2.5-pro-preview',     vision: true  },
  { id: 'google/gemini-2.5-flash-preview',   vision: true  },
  { id: 'google/gemini-1.5-flash',           vision: true  },
  { id: 'anthropic/claude-3-haiku',          vision: true  },
  { id: 'anthropic/claude-3.5-sonnet',       vision: true  },
  { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', vision: true  },
  { id: 'google/gemini-2.5-pro-preview-03-25', vision: false },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', vision: false },
  { id: 'meta-llama/llama-3.1-8b-instruct:free',  vision: false },
  { id: 'deepseek/deepseek-chat:free',             vision: false },
  { id: 'qwen/qwen-2.5-72b-instruct:free',         vision: false },
];

const GROQ_ALL_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'llama3-70b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'deepseek-r1-distill-llama-70b',
];

const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 jam

let scanCache = {
  or: { lastScan: 0, working: [], limited: [] },
  groq: { lastScan: 0, working: [], limited: [] },
};
let scanRunning = { or: false, groq: false };

function getKeys(prefix) {
  return [1,2,3,4,5].map(i => process.env[`${prefix}_${i}`]).filter(Boolean);
}

function isRateLimit(status, msg = '') {
  return status === 429 || /rate|quota|limit|exhausted|too.many/i.test(msg);
}

function isNotFound(status, msg = '') {
  return status === 404 || /not.found|no.endpoints|unavailable|does.not.exist/i.test(msg);
}

function isImageBase64(str) {
  if (!str || typeof str !== 'string') return false;
  return str.startsWith('data:image/') && str.includes('base64,');
}

// ══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════
let _promptBase = null;
async function getPrompt() {
  if (!_promptBase) {
    const base = join(process.cwd(), 'prompt');
    const files = ['prompt-persona.txt', 'prompt-aturan.txt', 'prompt-toko.txt'];
    const parts = [];
    for (const f of files) {
      try { parts.push((await readFile(join(base, f), 'utf-8')).trim()); } catch {}
    }
    _promptBase = parts.length
      ? parts.join('\n\n---\n\n')
      : `Kamu adalah XREZZKY AI, asisten cerdas XREZZKY OFFICIAL STORE.\nBahasa: Indonesia informal (bro/kak). Jawab akurat dan to the point.`;
  }
  const wib = new Date().toLocaleString('id-ID', {
    dateStyle: 'full', timeStyle: 'medium', timeZone: 'Asia/Jakarta',
  });
  return `${_promptBase}

Waktu sekarang (WIB): ${wib}

PENTING: Kamu BISA melihat dan menganalisis foto/gambar. Jika user kirim foto, analisis isinya secara detail. JANGAN bilang tidak bisa lihat gambar.`;
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN OPENROUTER
// ══════════════════════════════════════════════════════════════════════════
async function scanOpenRouter() {
  if (scanRunning.or) return;
  const keys = getKeys('OPENROUTER_API_KEY');
  if (!keys.length) return;
  scanRunning.or = true;

  const working = [], limited = [];
  const key = keys[0];
  console.log('[scan-or] mulai scan', OR_ALL_MODELS.length, 'model...');

  for (const m of OR_ALL_MODELS) {
    try {
      const t0 = Date.now();
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer': 'https://xrezzky-assistant.vercel.app',
          'X-Title': 'XREZZKY OFFICIAL STORE',
        },
        body: JSON.stringify({
          model: m.id,
          messages: [{ role: 'user', content: 'Balas: OK' }],
          max_tokens: 8,
        }),
      });
      const txt = await r.text();
      if (r.ok) {
        working.push({ ...m, ms: Date.now() - t0 });
        console.log(`[scan-or] ✓ ${m.id}`);
      } else {
        let msg = txt.slice(0,100);
        try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
        if (isRateLimit(r.status, msg)) {
          limited.push(m);
          console.log(`[scan-or] ⚠ ${m.id} limit`);
        } else {
          console.log(`[scan-or] ✗ ${m.id}: ${msg.slice(0,60)}`);
        }
      }
    } catch (e) {
      console.log(`[scan-or] ✗ ${m.id}: ${e.message?.slice(0,60)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  working.sort((a,b) => a.ms - b.ms);
  scanCache.or = { lastScan: Date.now(), working, limited };
  scanRunning.or = false;
  console.log(`[scan-or] selesai: ${working.length} OK, ${limited.length} limit`);
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN GROQ
// ══════════════════════════════════════════════════════════════════════════
async function scanGroq() {
  if (scanRunning.groq) return;
  const keys = getKeys('GROQ_API_KEY');
  if (!keys.length) return;
  scanRunning.groq = true;

  const working = [], limited = [];
  console.log('[scan-groq] mulai scan', GROQ_ALL_MODELS.length, 'model...');

  for (const model of GROQ_ALL_MODELS) {
    for (const key of keys) {
      try {
        const t0 = Date.now();
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'OK' }], max_tokens: 4 }),
        });
        if (r.ok) {
          working.push({ model, key, ms: Date.now() - t0 });
          console.log(`[scan-groq] ✓ ${model}`);
          break;
        }
        const txt = await r.text();
        let msg = txt.slice(0,100);
        try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
        if (isRateLimit(r.status, msg)) {
          limited.push({ model, key });
          console.log(`[scan-groq] ⚠ ${model} limit`);
        } else {
          console.log(`[scan-groq] ✗ ${model}: ${msg.slice(0,60)}`);
          break;
        }
      } catch (e) {
        console.log(`[scan-groq] ✗ ${model}: ${e.message?.slice(0,60)}`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  working.sort((a,b) => a.ms - b.ms);
  scanCache.groq = { lastScan: Date.now(), working, limited };
  scanRunning.groq = false;
  console.log(`[scan-groq] selesai: ${working.length} OK, ${limited.length} limit`);
}

function triggerScanIfNeeded() {
  const now = Date.now();
  if (now - scanCache.or.lastScan > SCAN_INTERVAL_MS) scanOpenRouter().catch(e => console.error(e));
  if (now - scanCache.groq.lastScan > SCAN_INTERVAL_MS) scanGroq().catch(e => console.error(e));
}

function getOrModels(needVision) {
  let models = scanCache.or.working.length ? scanCache.or.working : OR_ALL_MODELS.map(m => ({ ...m, ms: 9999 }));
  if (needVision) models = models.filter(m => m.vision);
  if (!models.length && needVision) models = OR_ALL_MODELS.filter(m => m.vision).map(m => ({ ...m, ms: 9999 }));
  return models;
}

async function callOR(key, modelId, sysprompt, msgs, imageB64) {
  const hasImage = isImageBase64(imageB64);
  const history = msgs.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' }));
  const lastText = msgs[msgs.length-1]?.content || '';
  let lastContent;
  if (hasImage) {
    const [meta, data] = imageB64.split(',');
    const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
    lastContent = [
      { type: 'text', text: lastText || 'Apa yang ada di gambar ini? Jelaskan secara detail.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
    ];
  } else {
    lastContent = lastText || 'Halo';
  }

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://xrezzky-assistant.vercel.app',
      'X-Title': 'XREZZKY OFFICIAL STORE',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: sysprompt }, ...history, { role: 'user', content: lastContent }],
      max_tokens: 2048,
    }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt.slice(0,150);
    try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
    const e = new Error(msg);
    e.status = r.status;
    e.limit = isRateLimit(r.status, msg);
    e.notFound = isNotFound(r.status, msg);
    throw e;
  }
  const result = JSON.parse(txt).choices?.[0]?.message?.content;
  if (!result) throw new Error('Response kosong');
  return result;
}

async function callGroq(key, model, sysprompt, msgs) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sysprompt }, ...msgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' }))],
      max_tokens: 1024,
    }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt.slice(0,150);
    try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
    const e = new Error(msg);
    e.status = r.status;
    e.limit = isRateLimit(r.status, msg);
    throw e;
  }
  return JSON.parse(txt).choices[0].message.content;
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method tidak diizinkan' });

  triggerScanIfNeeded();

  let { messages, user_message, user_image } = req.body || {};
  const hasImage = isImageBase64(user_image);
  console.log(`[debug] hasImage: ${hasImage}, image length: ${user_image?.length || 0}`);

  if (!messages?.length) {
    const text = user_message || '';
    if (!text && !hasImage) return res.status(400).json({ error: 'Kirim pesan atau foto dulu bro' });
    messages = [{ role: 'user', content: text }];
  }

  const sysprompt = await getPrompt();
  const orKeys = getKeys('OPENROUTER_API_KEY');
  const orShuffled = [...orKeys].sort(() => Math.random() - 0.5);

  // ── FOTO ──────────────────────────────────────────────────────────────
  if (hasImage) {
    const visionModels = getOrModels(true);
    let lastErr;
    for (const m of visionModels) {
      for (const key of orShuffled) {
        try {
          console.log(`[vision] mencoba ${m.id}`);
          const result = await callOR(key, m.id, sysprompt, messages, user_image);
          console.log(`[vision] OK: ${m.id}`);
          return res.status(200).json({ response: result, provider: 'openrouter', model: m.id });
        } catch (e) {
          lastErr = e;
          console.error(`[vision] ${m.id} gagal: ${e.message?.slice(0,80)}`);
          if (e.notFound) break;
          if (!e.limit) break;
        }
      }
    }
    return res.status(500).json({ response: 'Maaf bro, gagal baca foto sekarang. Coba lagi.', error: lastErr?.message });
  }

  // ── TEKS via Groq ──────────────────────────────────────────────────────
  const groqWorking = scanCache.groq.working;
  if (groqWorking.length) {
    for (const { model, key } of groqWorking) {
      try {
        const result = await callGroq(key, model, sysprompt, messages);
        console.log(`[groq] OK: ${model}`);
        return res.status(200).json({ response: result, provider: 'groq', model });
      } catch (e) {
        console.error(`[groq] ${model} gagal: ${e.message?.slice(0,80)}`);
        if (e.limit) {
          const altKeys = getKeys('GROQ_API_KEY').filter(k => k !== key);
          for (const altKey of altKeys) {
            try {
              const result = await callGroq(altKey, model, sysprompt, messages);
              return res.status(200).json({ response: result, provider: 'groq', model });
            } catch {}
          }
        }
      }
    }
  } else {
    const groqKeys = getKeys('GROQ_API_KEY');
    for (const key of groqKeys) {
      for (const model of GROQ_ALL_MODELS) {
        try {
          const result = await callGroq(key, model, sysprompt, messages);
          console.log(`[groq-raw] OK: ${model}`);
          if (!scanCache.groq.working.find(w => w.model === model)) {
            scanCache.groq.working.push({ model, key, ms: 0 });
          }
          return res.status(200).json({ response: result, provider: 'groq', model });
        } catch (e) {
          if (!e.limit) break;
        }
      }
    }
  }

  // ── FALLBACK OpenRouter teks ──────────────────────────────────────────
  const textModels = getOrModels(false);
  let lastErr;
  for (const m of textModels) {
    for (const key of orShuffled) {
      try {
        const result = await callOR(key, m.id, sysprompt, messages, null);
        console.log(`[or-text] OK: ${m.id}`);
        return res.status(200).json({ response: result, provider: 'openrouter', model: m.id });
      } catch (e) {
        lastErr = e;
        console.error(`[or-text] ${m.id} gagal: ${e.message?.slice(0,80)}`);
        if (e.notFound) break;
        if (!e.limit) break;
      }
    }
  }

  return res.status(500).json({ response: 'Semua AI provider lagi down bro, coba lagi bentar.', error: lastErr?.message });
        }
