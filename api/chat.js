// api/chat.js — Vercel Serverless
// Auto-scan model tiap 1 jam, pakai yang bisa saja
// Provider: OpenRouter (utama) + Groq (teks)
// Env: GROQ_API_KEY_1..5, OPENROUTER_API_KEY_1..5

import { readFile } from 'fs/promises';
import { join } from 'path';

// ── PRIORITY MODELS — selalu dicoba pertama ───────────────────────────────
// Ini yang dipaksa, tidak nunggu scan
const OR_PRIORITY_VISION = [
  'google/gemini-2.0-flash-001',
  'google/gemini-2.5-pro-preview',
  'anthropic/claude-3-haiku',
];

const OR_PRIORITY_TEXT = [
  'google/gemini-2.0-flash-001',
  'google/gemini-2.5-pro-preview',
  'anthropic/claude-3-haiku',
];

// ── SEMUA MODEL (untuk scan background) ──────────────────────────────────
const OR_ALL_MODELS = [
  // Gemini — vision + teks
  { id: 'google/gemini-2.0-flash-001',       vision: true  },
  { id: 'google/gemini-2.5-pro-preview',     vision: true  },
  { id: 'google/gemini-2.5-flash-preview',   vision: true  },
  { id: 'google/gemini-1.5-flash',           vision: true  },
  // Claude — vision + teks
  { id: 'anthropic/claude-3-haiku',          vision: true  },
  { id: 'anthropic/claude-3.5-sonnet',       vision: true  },
  // Llama vision
  { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', vision: true  },
  // Teks only
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

// ══════════════════════════════════════════════════════════════════════════
// CACHE HASIL SCAN
// ══════════════════════════════════════════════════════════════════════════
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 jam

let scanCache = {
  or: {
    lastScan: 0,
    working: [],       // [{ id, vision, ms }] — model OK
    limited: [],       // model rate-limited (bisa dicoba lagi)
  },
  groq: {
    lastScan: 0,
    working: [],       // [{ model, key, ms }]
    limited: [],
  },
};

let scanRunning = { or: false, groq: false };

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════
function getKeys(prefix) {
  return [1,2,3,4,5].map(i => process.env[`${prefix}_${i}`]).filter(Boolean);
}

function pickRandom(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function isRateLimit(status, msg = '') {
  return status === 429 || /rate|quota|limit|exhausted|too.many/i.test(msg);
}

function isNotFound(status, msg = '') {
  return status === 404 || /not.found|no.endpoints|unavailable|does.not.exist/i.test(msg);
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
// SCAN OPENROUTER — test semua model
// ══════════════════════════════════════════════════════════════════════════
async function scanOpenRouter() {
  if (scanRunning.or) return;
  const keys = getKeys('OPENROUTER_API_KEY');
  if (!keys.length) return;
  scanRunning.or = true;

  const working = [];
  const limited = [];
  const key = keys[0]; // pakai key pertama buat scan

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
        const ms = Date.now() - t0;
        working.push({ ...m, ms });
        console.log(`[scan-or] ✓ ${m.id} (${ms}ms)`);
      } else {
        let msg = txt.slice(0, 100);
        try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
        if (isRateLimit(r.status, msg)) {
          limited.push(m);
          console.log(`[scan-or] ⚠ ${m.id} limit`);
        } else {
          console.log(`[scan-or] ✗ ${m.id}: ${msg.slice(0, 60)}`);
        }
      }
    } catch (e) {
      console.log(`[scan-or] ✗ ${m.id}: ${e.message?.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 200)); // delay antar request
  }

  // Urutkan: tercepat dulu
  working.sort((a, b) => a.ms - b.ms);
  scanCache.or = { lastScan: Date.now(), working, limited };
  scanRunning.or = false;
  console.log(`[scan-or] selesai: ${working.length} OK, ${limited.length} limit`);
}

// ══════════════════════════════════════════════════════════════════════════
// SCAN GROQ — test semua model
// ══════════════════════════════════════════════════════════════════════════
async function scanGroq() {
  if (scanRunning.groq) return;
  const keys = getKeys('GROQ_API_KEY');
  if (!keys.length) return;
  scanRunning.groq = true;

  const working = [];
  const limited = [];

  console.log('[scan-groq] mulai scan', GROQ_ALL_MODELS.length, 'model...');

  for (const model of GROQ_ALL_MODELS) {
    for (const key of keys) {
      try {
        const t0 = Date.now();
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'OK' }],
            max_tokens: 4,
          }),
        });
        if (r.ok) {
          const ms = Date.now() - t0;
          working.push({ model, key, ms });
          console.log(`[scan-groq] ✓ ${model} key${keys.indexOf(key)+1} (${ms}ms)`);
          break; // model ini OK dengan key ini, skip key lain
        }
        const txt = await r.text();
        let msg = txt.slice(0, 100);
        try { msg = JSON.parse(txt)?.error?.message || msg; } catch {}
        if (isRateLimit(r.status, msg)) {
          limited.push({ model, key });
          console.log(`[scan-groq] ⚠ ${model} key${keys.indexOf(key)+1} limit`);
        } else {
          console.log(`[scan-groq] ✗ ${model}: ${msg.slice(0, 60)}`);
          break; // model tidak tersedia, skip semua key
        }
      } catch (e) {
        console.log(`[scan-groq] ✗ ${model}: ${e.message?.slice(0, 60)}`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }

  working.sort((a, b) => a.ms - b.ms);
  scanCache.groq = { lastScan: Date.now(), working, limited };
  scanRunning.groq = false;
  console.log(`[scan-groq] selesai: ${working.length} OK, ${limited.length} limit`);
}

// Trigger scan kalau sudah waktunya (non-blocking)
function triggerScanIfNeeded() {
  const now = Date.now();
  if (now - scanCache.or.lastScan > SCAN_INTERVAL_MS) {
    scanOpenRouter().catch(e => console.error('[scan-or error]', e.message));
  }
  if (now - scanCache.groq.lastScan > SCAN_INTERVAL_MS) {
    scanGroq().catch(e => console.error('[scan-groq error]', e.message));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// GET WORKING MODELS — ambil dari cache, fallback ke semua kalau kosong
// ══════════════════════════════════════════════════════════════════════════
function getOrModels(needVision) {
  const priority = needVision ? OR_PRIORITY_VISION : OR_PRIORITY_TEXT;
  const { working } = scanCache.or;

  if (!working.length) {
    // Scan belum selesai — pakai priority list langsung
    return priority.map(id => {
      const meta = OR_ALL_MODELS.find(m => m.id === id);
      return { id, vision: meta?.vision ?? true, ms: 0 };
    });
  }

  // Scan sudah ada — gabungkan: priority yang OK duluan, lalu sisa dari scan
  const workingIds = working.map(m => m.id);
  const priorityWorking = priority
    .filter(id => workingIds.includes(id))
    .map(id => working.find(m => m.id === id));

  const otherWorking = working
    .filter(m => !priority.includes(m.id))
    .filter(m => needVision ? m.vision : true);

  const result = [...priorityWorking.filter(Boolean), ...otherWorking];

  // Kalau tidak ada yang cocok dari scan, tetap pakai priority
  if (!result.length) {
    return priority.map(id => ({ id, vision: true, ms: 0 }));
  }
  return result;
}

function getGroqWorking() {
  return scanCache.groq.working;
}

// ══════════════════════════════════════════════════════════════════════════
// CALL OPENROUTER
// ══════════════════════════════════════════════════════════════════════════
async function callOR(key, modelId, sysprompt, msgs, imageB64) {
  const hasImg = !!(imageB64?.includes(','));
  const history = msgs.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content || '',
  }));
  const lastText = msgs[msgs.length - 1]?.content || '';
  let lastContent;
  if (hasImg) {
    const [meta, data] = imageB64.split(',');
    const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
    lastContent = [
      { type: 'text', text: lastText || 'Lihat dan ceritakan isi gambar ini secara detail.' },
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
      messages: [
        { role: 'system', content: sysprompt },
        ...history,
        { role: 'user', content: lastContent },
      ],
      max_tokens: 2048,
    }),
  });

  const txt = await r.text();
  if (!r.ok) {
    let msg = txt.slice(0, 150);
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

// ══════════════════════════════════════════════════════════════════════════
// CALL GROQ
// ══════════════════════════════════════════════════════════════════════════
async function callGroq(key, model, sysprompt, msgs) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysprompt },
        ...msgs.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content || '',
        })),
      ],
      max_tokens: 1024,
    }),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt.slice(0, 150);
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

  // Trigger scan background (non-blocking)
  triggerScanIfNeeded();

  // Parse body
  let { messages, user_message, user_image } = req.body || {};
  if (!messages?.length) {
    const text = user_message || null;
    const hasImg = !!(user_image?.includes(','));
    if (!text && !hasImg) return res.status(400).json({ error: 'Kirim pesan atau foto dulu bro' });
    messages = [{ role: 'user', content: text || '' }];
  }

  const hasImage = !!(user_image?.includes(','));
  const sysprompt = await getPrompt();
  const orKeys = getKeys('OPENROUTER_API_KEY');
  const orShuffled = [...orKeys].sort(() => Math.random() - 0.5);

  // ── FOTO → OpenRouter vision ──────────────────────────────────────────
  if (hasImage) {
    const visionModels = getOrModels(true);
    let lastErr;

    for (const m of visionModels) {
      for (const key of orShuffled) {
        try {
          const result = await callOR(key, m.id, sysprompt, messages, user_image);
          console.log(`[vision] OK: ${m.id}`);
          return res.status(200).json({ response: result, provider: 'openrouter', model: m.id });
        } catch (e) {
          lastErr = e;
          console.error(`[vision] ${m.id}: ${e.message?.slice(0, 80)}`);
          if (e.notFound) break; // model tidak ada, skip ke model berikutnya
          if (!e.limit) break;   // error lain, skip key ini
        }
      }
    }
    return res.status(500).json({
      response: 'Maaf bro, gagal baca foto sekarang. Coba lagi.',
      error: lastErr?.message,
    });
  }

  // ── TEKS → Groq dulu (dari cache scan) ───────────────────────────────
  const groqWorking = getGroqWorking();
  if (groqWorking.length) {
    // Coba dari yang tercepat
    for (const { model, key } of groqWorking) {
      try {
        const result = await callGroq(key, model, sysprompt, messages);
        console.log(`[groq] OK: ${model}`);
        return res.status(200).json({ response: result, provider: 'groq', model });
      } catch (e) {
        console.error(`[groq] ${model}: ${e.message?.slice(0, 80)}`);
        // kalau limit, tandai dan coba berikutnya
        if (e.limit) {
          // tandai key ini sebagai limit, coba key lain untuk model sama
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
    // Scan belum jalan — coba langsung semua key x model
    const groqKeys = getKeys('GROQ_API_KEY');
    for (const key of groqKeys) {
      for (const model of GROQ_ALL_MODELS) {
        try {
          const result = await callGroq(key, model, sysprompt, messages);
          console.log(`[groq-raw] OK: ${model}`);
          // Simpan ke cache supaya request berikutnya lebih cepat
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

  // ── FALLBACK → OpenRouter teks ────────────────────────────────────────
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
        console.error(`[or-text] ${m.id}: ${e.message?.slice(0, 80)}`);
        if (e.notFound) break;
        if (!e.limit) break;
      }
    }
  }

  return res.status(500).json({
    response: 'Semua AI provider lagi down bro, coba lagi bentar.',
    error: lastErr?.message,
  });
}
