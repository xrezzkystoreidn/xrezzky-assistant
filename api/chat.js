// ==========================================
// api/chat.js — Vercel Serverless
// Provider: Groq (auto-test model) + OpenRouter (2 model)
// Tanpa Supabase, tanpa Gemini
// System prompt dari folder /prompt/*.txt
// Env: GROQ_API_KEY_1..5, OPENROUTER_API_KEY_1..5
// ==========================================

import { readFile } from 'fs/promises';
import { join } from 'path';

// ── Model lists ───────────────────────────────────────────────────────────
const OR_MODELS = [
  'google/gemini-2.5-pro-preview',
  'anthropic/claude-3-haiku',
];

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama3-70b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'deepseek-r1-distill-llama-70b',
];

// ── Baca folder prompt/ ───────────────────────────────────────────────────
async function loadPrompts() {
  const base = join(process.cwd(), 'prompt');
  const files = [
    'prompt-persona.txt',
    'prompt-aturan.txt',
    'prompt-toko.txt',
  ];

  const parts = [];
  for (const file of files) {
    try {
      const content = await readFile(join(base, file), 'utf-8');
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.warn(`[prompt] Gagal baca ${file}:`, e.message);
    }
  }

  return parts.join('\n\n---\n\n');
}

// Cache prompt supaya tidak baca file tiap request
let cachedPrompt = null;
async function getSystemPrompt() {
  if (!cachedPrompt) {
    const fromFiles = await loadPrompts();
    const wib = new Date().toLocaleString('id-ID', {
      dateStyle: 'full', timeStyle: 'medium', timeZone: 'Asia/Jakarta'
    });

    cachedPrompt = fromFiles
      ? `${fromFiles}\n\nWaktu sekarang (WIB): ${wib}`
      : `Kamu adalah XREZZKY AI, asisten cerdas XREZZKY OFFICIAL STORE.\nWaktu sekarang (WIB): ${wib}\nBahasa: Indonesia informal (bro/kak). Jawab akurat dan to the point.`;
  } else {
    // Update waktu tiap request meski prompt ter-cache
    cachedPrompt = cachedPrompt.replace(
      /Waktu sekarang \(WIB\): .+/,
      `Waktu sekarang (WIB): ${new Date().toLocaleString('id-ID', {
        dateStyle: 'full', timeStyle: 'medium', timeZone: 'Asia/Jakarta'
      })}`
    );
  }
  return cachedPrompt;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getKeys(prefix) {
  return [1,2,3,4,5].map(i => process.env[`${prefix}_${i}`]).filter(Boolean);
}

function isLimit(status, msg = '') {
  const m = msg.toLowerCase();
  return status === 429 ||
    m.includes('rate') || m.includes('quota') ||
    m.includes('limit') || m.includes('resource_exhausted') ||
    m.includes('too many');
}

// ── GROQ — auto-test model ────────────────────────────────────────────────
async function findWorkingGroq(keys) {
  for (const key of keys) {
    for (const model of GROQ_MODELS) {
      try {
        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'OK' }],
            max_tokens: 4,
          }),
        });
        if (resp.ok) return { key, model };
        const e = await resp.text();
        if (!isLimit(resp.status, e)) break;
      } catch {}
    }
  }
  return null;
}

async function callGroq(key, model, messages, systemPrompt) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
  }
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 1024 }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    let msg = err.slice(0, 200);
    try { msg = JSON.parse(err)?.error?.message || msg; } catch {}
    const e = new Error(msg); e.status = resp.status; e.isLimit = isLimit(resp.status, msg); throw e;
  }
  const data = await resp.json();
  return data.choices[0].message.content;
}

// ── OPENROUTER ────────────────────────────────────────────────────────────
async function callOpenRouter(key, model, messages, userImage, systemPrompt) {
  const hasImg = !!(userImage?.includes(','));
  const msgs = [{ role: 'system', content: systemPrompt }];

  for (const m of messages.slice(0, -1)) {
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
  }

  const last = messages[messages.length - 1];
  let userContent = last?.content || 'Halo';
  if (hasImg) {
    try {
      const [meta, data] = userImage.split(',');
      const mime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
      userContent = [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
        { type: 'text', text: last?.content || 'Lihat gambar ini' },
      ];
    } catch {}
  }
  msgs.push({ role: 'user', content: userContent });

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://xrezzky-assistant.vercel.app',
      'X-Title': 'XREZZKY OFFICIAL STORE',
    },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 1024 }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    let msg = err.slice(0, 200);
    try { msg = JSON.parse(err)?.error?.message || msg; } catch {}
    const e = new Error(msg); e.status = resp.status; e.isLimit = isLimit(resp.status, msg); throw e;
  }
  const data = await resp.json();
  const result = data.choices?.[0]?.message?.content;
  if (!result) throw new Error('Response kosong dari OpenRouter');
  return result;
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

  const { messages, user_image } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages wajib diisi (array)' });

  const systemPrompt = await getSystemPrompt();
  const groqKeys = getKeys('GROQ_API_KEY');
  const orKeys   = getKeys('OPENROUTER_API_KEY');
  let lastError  = null;

  // 1. GROQ — auto-test semua model
  if (groqKeys.length) {
    try {
      const working = await findWorkingGroq(groqKeys);
      if (working) {
        const response = await callGroq(working.key, working.model, messages, systemPrompt);
        if (response) return res.status(200).json({ response, provider: 'groq', model: working.model });
      }
    } catch (e) {
      lastError = e.message;
      console.error('[groq]:', e.message);
    }
  }

  // 2. OPENROUTER — rotate key acak, 2 model
  if (orKeys.length) {
    const shuffled = [...orKeys].sort(() => Math.random() - 0.5);
    for (const key of shuffled) {
      for (const model of OR_MODELS) {
        try {
          const response = await callOpenRouter(key, model, messages, user_image, systemPrompt);
          if (response) return res.status(200).json({ response, provider: 'openrouter', model });
        } catch (e) {
          lastError = e.message;
          console.error(`[openrouter] ${model}:`, e.message);
          if (!e.isLimit) break;
        }
      }
    }
  }

  return res.status(500).json({
    response: 'Semua AI provider lagi down bro, coba lagi bentar.',
    error: lastError,
  });
}
