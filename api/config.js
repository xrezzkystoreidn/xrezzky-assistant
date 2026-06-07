// api/config.js — Vercel
// Kasih API keys + system prompt ke frontend
// Frontend langsung panggil provider (Groq/OpenRouter) dari browser

import { readFile } from 'fs/promises';
import { join }     from 'path';

async function loadPrompt() {
  const base  = join(process.cwd(), 'prompt');
  const files = ['prompt-persona.txt', 'prompt-aturan.txt', 'prompt-toko.txt'];
  const parts = [];
  for (const f of files) {
    try { parts.push((await readFile(join(base, f), 'utf-8')).trim()); } catch {}
  }
  return parts.length
    ? parts.join('\n\n---\n\n')
    : 'Kamu adalah XREZZKY AI, asisten cerdas XREZZKY OFFICIAL STORE.\nBahasa: Indonesia informal (bro/kak).';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const prompt = await loadPrompt();

  // Kirim semua keys dan prompt ke frontend
  return res.status(200).json({
    prompt,
    groq: [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]).filter(Boolean),
    openrouter: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`]).filter(Boolean),
  });
}
