// ═══════════════════════════════════════════════════════════════════════════
//  XREZZKY AI — api/chat.js  (Vercel Serverless)
//  Features : Firebase Auth verify · Multi-provider AI · Web Search
//             Realtime datetime · Math solver · Role-based rate limit
//
//  PROVIDER PRIORITY (aktif):
//    1. OpenRouter  ← UTAMA  (model: gemini, claude, llama via OR)
//    2. Groq        ← BACKUP (model: llama-3.3-70b, llama-3.1-8b)
//
//  PROVIDER NONAKTIF:
//    ✗ Gemini Direct  — dinonaktifkan, tapi model Gemini tetap bisa
//                       diakses LEWAT OpenRouter (google/gemini-*)
//
//  ENV VARS YANG DIBUTUHKAN:
//    OPENROUTER_API_KEY_1 .. _5
//    GROQ_API_KEY_1 .. _5
//    (GEMINI_API_KEY_* tidak diperlukan, biarkan kosong)
//
//  Author : ZEROXREZZ
// ═══════════════════════════════════════════════════════════════════════════

import admin from "firebase-admin";

// ── Firebase Admin SDK init (singleton) ─────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}
const db   = admin.database();
const auth = admin.auth();

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════
const GITHUB_RAW = "https://raw.githubusercontent.com/xrezzkystoreidn/xrezzky-assistant/main/prompt";

const DEFAULT_ROLE_LIMITS = {
  OWNER:   { max_chat_limit: 99999, max_photo_limit: 99999 }, // tertinggi — full akses
  ADMIN:   { max_chat_limit: 99999, max_photo_limit: 99999 },
  SELLER:  { max_chat_limit: 200,   max_photo_limit: 50    },
  MEMBER:  { max_chat_limit: 50,    max_photo_limit: 10    },
  GUEST:   { max_chat_limit: 10,    max_photo_limit: 0     },
  BANNED:  { max_chat_limit: 0,     max_photo_limit: 0     },
  STOPPED: { max_chat_limit: 0,     max_photo_limit: 0     },
};

// Role hierarchy — semakin kecil angka semakin tinggi level
const ROLE_LEVEL = { OWNER:0, ADMIN:1, SELLER:2, MEMBER:3, GUEST:4, BANNED:99, STOPPED:99 };
const UNLIMITED_ROLES = ["OWNER","ADMIN"];

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah XREZZKY AI, asisten dari XREZZKY OFFICIAL STORE — platform jual beli digital gaming (akun, item, boosting, top-up).

GAYA NGOBROL:
- Santai tapi tetap jelas dan membantu — kayak ngobrol sama teman yang paham banyak hal.
- Jawab sesuai yang ditanya, gak perlu muter-muter, tapi juga gak perlu kaku banget.
- Boleh pakai sapaan natural kalau emang konteksnya pas (misal user baru mulai chat dengan "halo").
- Kalau user nanya sesuatu yang berkaitan sama obrolan sebelumnya, INGAT dan SAMBUNGKAN — jangan dianggap pertanyaan baru yang berdiri sendiri.
- Untuk hal teknis, coding, atau belajar: jelasin selengkap yang dibutuhkan, gak usah dibatasi panjangnya.
- Kalau ada gambar, perhatikan baik-baik dan jawab sesuai konteks gambar + obrolan sebelumnya.
- Kalau ada hasil pencarian web, manfaatkan buat jawaban yang akurat.
- Untuk matematika, kerjain step-by-step yang jelas.
- Gak usah sebut-sebut nama model AI atau detail teknis provider ke user.
- Gak usah sebutin waktu/tanggal kecuali emang ditanya.
- Kalau gak tahu jawabannya, ngomong aja jujur — jangan ngarang.

INGAT: Setiap chat itu bagian dari satu obrolan yang berkesinambungan. Pakai history percakapan sebelumnya untuk paham konteks — siapa/apa yang dibahas, biar gak salah jawab atau lupa.`;

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════
const now     = () => Date.now();
const todayWIB = () => new Date(Date.now() + 7*3600000).toISOString().slice(0,10);

function getKeys(prefix) {
  return [1,2,3,4,5].map(i => process.env[`${prefix}_${i}`]).filter(Boolean);
}
function pick(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
function nowStringWIB() {
  // Tetap untuk backward compat
  return new Date(Date.now() + 7*3600000)
    .toLocaleString("id-ID", {
      weekday:"long", day:"numeric", month:"long", year:"numeric",
      hour:"2-digit", minute:"2-digit", timeZone:"Asia/Jakarta"
    });
}

function nowAllZones() {
  const ts = Date.now();
  const f  = (tz, loc="id-ID") => new Date(ts).toLocaleString(loc, {
    weekday:"short", day:"numeric", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit", timeZone: tz
  });
  return {
    WIB:       f("Asia/Jakarta"),           // UTC+7  — Sumatra, Jawa, Kalimantan Barat/Tengah
    WITA:      f("Asia/Makassar"),          // UTC+8  — Bali, NTB, NTT, Kalimantan Timur/Selatan, Sulawesi
    WIT:       f("Asia/Jayapura"),          // UTC+9  — Maluku, Papua
    London:    f("Europe/London", "en-GB"),
    NewYork:   f("America/New_York", "en-US"),
    Tokyo:     f("Asia/Tokyo", "ja-JP"),
    Dubai:     f("Asia/Dubai", "ar-AE"),
    Sydney:    f("Australia/Sydney", "en-AU"),
    Singapore: f("Asia/Singapore", "en-SG"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  FETCH SYSTEM PROMPT FROM GITHUB
// ═══════════════════════════════════════════════════════════════════════════
async function fetchSystemPrompt() {
  const files = ["prompt-aturan.txt", "prompt-persona.txt", "prompt-toko.txt"];
  const parts = [];
  for (const file of files) {
    try {
      const res = await fetch(`${GITHUB_RAW}/${file}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) parts.push(text.trim());
      }
    } catch {}
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  WEB SEARCH (Google Custom Search API)
// ═══════════════════════════════════════════════════════════════════════════
async function webSearch(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx     = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) return null;

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=5&hl=id`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();

    if (!data.items?.length) return null;

    const results = data.items.slice(0, 5).map(item => ({
      title:   item.title,
      snippet: item.snippet?.replace(/\n/g," ") || "",
      link:    item.link,
    }));

    return results.map((r, i) =>
      `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}`
    ).join("\n\n");
  } catch { return null; }
}

// ── Detect if message needs web search ──────────────────────────────────────
function needsSearch(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();

  // Explicit search triggers
  const searchTriggers = [
    "berita", "terbaru", "hari ini", "sekarang", "terkini", "update",
    "harga", "price", "berapa harga", "cuaca", "weather", "jadwal",
    "siapa", "who is", "apa itu", "what is", "kapan", "dimana",
    "cari", "search", "google", "cek", "info", "informasi tentang",
    "trending", "viral", "rilis", "release", "launch", "keluar kapan",
    "film", "lagu", "artis", "game baru", "patch", "update game",
    "nilai tukar", "kurs", "dollar", "bitcoin", "crypto",
    "cara", "tutorial", "bagaimana cara", "how to",
  ];

  // Math/calculation — do NOT search
  const mathPattern = /[\d\+\-\*\/\^\=\(\)]+|hitung|kalkul|integral|turunan|limit|matriks|persamaan|modulo|pangkat|akar|sin|cos|tan|log/i;
  if (mathPattern.test(m) && !searchTriggers.some(t => m.includes(t))) return false;

  return searchTriggers.some(trigger => m.includes(trigger));
}

// ═══════════════════════════════════════════════════════════════════════════
//  MATH SOLVER PROMPT BOOSTER
// ═══════════════════════════════════════════════════════════════════════════
function needsMath(msg) {
  if (!msg) return false;
  return /[\d\+\-\*\/\^\=\(\)]{3,}|hitung|kalkul|integral|turunan|limit\s|matriks|persamaan|modulo|pangkat|akar\s|sin\(|cos\(|tan\(|log\(|sigma|kombinasi|permutasi|statistik|mean|median|modus|standar deviasi/i.test(msg);
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  PROVIDER: OpenRouter  ← UTAMA
//  Semua model diakses lewat OR termasuk Gemini, Claude, Llama
// ════════════════════════════════════════════════════════════════════════════
async function callOpenRouter(apiKey, model, systemPrompt, userMessage, userImage, history=[]) {
  let userContent;
  if (userImage?.includes(",")) {
    try {
      const split    = userImage.split(",");
      const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
      userContent = [
        { type:"image_url", image_url:{ url:`data:${mimeType};base64,${split[1]}` } },
        { type:"text",      text: userMessage || "Lihat gambar ini." },
      ];
    } catch { userContent = userMessage || "Halo"; }
  } else {
    userContent = userMessage || "Halo";
  }

  // Susun messages: system → history (max 10 pesan terakhir) → pesan baru
  const messages = [
    { role:"system", content:systemPrompt },
    ...history.map(h => ({ role: h.role==="bot"?"assistant":"user", content: h.text||"" })),
    { role:"user", content:userContent },
  ];

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:  "POST",
    signal:  AbortSignal.timeout(28000),
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer":  "https://xrezzky-assistant.vercel.app",
      "X-Title":       "XREZZKY AI",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  4096,
      temperature: 0.75,
    }),
  });
  if (!res.ok) {
    const e = await res.text();
    throw new Error(`OpenRouter(${model}) ${res.status}: ${e.slice(0,200)}`);
  }
  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) throw new Error(`OpenRouter(${model}) empty response`);
  return data.choices[0].message.content;
}

// ════════════════════════════════════════════════════════════════════════════
//  PROVIDER: Groq  ← BACKUP
//  Hanya teks, sangat cepat, gratis
// ════════════════════════════════════════════════════════════════════════════
async function callGroq(apiKey, model, systemPrompt, userMessage, history=[]) {
  const messages = [
    { role:"system", content:systemPrompt },
    ...history.map(h => ({ role: h.role==="bot"?"assistant":"user", content: h.text||"" })),
    { role:"user", content:userMessage||"Halo" },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    signal:  AbortSignal.timeout(20000),
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  8192,
      temperature: 0.75,
    }),
  });
  if (!res.ok) {
    const e = await res.text();
    throw new Error(`Groq(${model}) ${res.status}: ${e.slice(0,200)}`);
  }
  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) throw new Error(`Groq(${model}) empty response`);
  return data.choices[0].message.content;
}

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI DIRECT — NONAKTIF
//  Fungsi ini sengaja dikosongkan. Model Gemini tetap bisa dipakai
//  lewat OpenRouter dengan prefix "google/gemini-*"
// ════════════════════════════════════════════════════════════════════════════
// async function callGemini(...) { /* DISABLED */ }

// ════════════════════════════════════════════════════════════════════════════
//  BUILD QUEUE
//  Urutan prioritas: OpenRouter dulu, fallback ke Groq
//  Untuk gambar: hanya OR yang support vision
// ════════════════════════════════════════════════════════════════════════════
function buildQueue(hasImage, history=[]) {
  const orKeys = getKeys("OPENROUTER_API_KEY");
  const grKeys = getKeys("GROQ_API_KEY");
  // Gemini direct keys sengaja tidak dibaca — DISABLED
  // const gKeys = getKeys("GEMINI_API_KEY"); // ← nonaktif

  const q = [];

  if (hasImage) {
    // ── Gambar: hanya OpenRouter yang support vision ──
    // Prioritas: Gemini via OR (gratis) → Claude via OR → Llama vision via OR
    if (orKeys.length) {
      const k1 = pick(orKeys);
      q.push({ name:"OR/gemini-2.0-flash",    fn:(sp,m,i)=>callOpenRouter(k1,"google/gemini-2.0-flash-001",sp,m,i,history) });
      const k2 = pick(orKeys);
      q.push({ name:"OR/gemini-flash-lite",   fn:(sp,m,i)=>callOpenRouter(k2,"google/gemini-flash-1.5",sp,m,i,history) });
      const k3 = pick(orKeys);
      q.push({ name:"OR/claude-3-haiku",      fn:(sp,m,i)=>callOpenRouter(k3,"anthropic/claude-3-haiku",sp,m,i,history) });
      const k4 = pick(orKeys);
      q.push({ name:"OR/gemini-2.5-pro",      fn:(sp,m,i)=>callOpenRouter(k4,"google/gemini-2.5-pro-preview",sp,m,i,history) });
      const k5 = pick(orKeys);
      q.push({ name:"OR/llama-vision-free",   fn:(sp,m,i)=>callOpenRouter(k5,"meta-llama/llama-3.2-11b-vision-instruct:free",sp,m,i,history) });
    }
    // Groq tidak support gambar — skip
    return q;
  }

  // ── Teks: OpenRouter (utama) → Groq (backup) ──

  // === OPENROUTER — slot 1-4 (utama) ===
  if (orKeys.length) {
    const k1 = pick(orKeys);
    q.push({ name:"OR/gemini-2.0-flash",      fn:(sp,m)=>callOpenRouter(k1,"google/gemini-2.0-flash-001",sp,m,null,history) });

    const k2 = pick(orKeys);
    q.push({ name:"OR/deepseek-v3",           fn:(sp,m)=>callOpenRouter(k2,"deepseek/deepseek-chat",sp,m,null,history) });

    const k3 = pick(orKeys);
    q.push({ name:"OR/claude-3-haiku",        fn:(sp,m)=>callOpenRouter(k3,"anthropic/claude-3-haiku",sp,m,null,history) });

    const k4 = pick(orKeys);
    q.push({ name:"OR/gemini-2.5-pro",        fn:(sp,m)=>callOpenRouter(k4,"google/gemini-2.5-pro-preview",sp,m,null,history) });
  }

  // === GROQ — slot 5-6 (backup cepat) ===
  if (grKeys.length) {
    const g1 = pick(grKeys);
    q.push({ name:"Groq/llama-3.3-70b",       fn:(sp,m)=>callGroq(g1,"llama-3.3-70b-versatile",sp,m,history) });

    const g2 = pick(grKeys);
    q.push({ name:"Groq/llama-3.1-8b",        fn:(sp,m)=>callGroq(g2,"llama-3.1-8b-instant",sp,m,history) });
  }

  // === OPENROUTER FREE FALLBACK — slot 7-8 (last resort) ===
  if (orKeys.length) {
    const k5 = pick(orKeys);
    q.push({ name:"OR/llama-3.1-free",        fn:(sp,m)=>callOpenRouter(k5,"meta-llama/llama-3.1-8b-instruct:free",sp,m,null,history) });

    const k6 = pick(orKeys);
    q.push({ name:"OR/mistral-7b-free",       fn:(sp,m)=>callOpenRouter(k6,"mistralai/mistral-7b-instruct:free",sp,m,null,history) });
  }

  return q;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function ensureUserConfig(uid, defaultRole="MEMBER", meta={}) {
  const ref  = db.ref(`users_config/${uid}`);
  const snap = await ref.once("value");

  // Baca limit dari system_settings/role_limits jika ada
  let roleLimits = {};
  try {
    const rlSnap = await db.ref("system_settings/role_limits").once("value");
    roleLimits = rlSnap.val() || {};
  } catch {}

  if (!snap.exists()) {
    const dbLim  = roleLimits[defaultRole] || {};
    const defLim = DEFAULT_ROLE_LIMITS[defaultRole];
    const cfg = {
      role:            defaultRole,
      max_chat_limit:  dbLim.max_chat_limit  ?? defLim.max_chat_limit,
      max_photo_limit: dbLim.max_photo_limit ?? defLim.max_photo_limit,
      name:            meta.name  || "",
      email:           meta.email || "",
      created_at:      now(),
    };
    await ref.set(cfg);
    return cfg;
  }

  const cfg = snap.val();
  // Kalau role_limits di DB berubah, update limit user yang belum custom
  if (roleLimits[cfg.role] && !cfg.custom_limit) {
    const rl = roleLimits[cfg.role];
    await ref.update({
      max_chat_limit:  rl.max_chat_limit,
      max_photo_limit: rl.max_photo_limit,
    });
    cfg.max_chat_limit  = rl.max_chat_limit;
    cfg.max_photo_limit = rl.max_photo_limit;
  }
  return cfg;
}

async function getDailyCounter(uid) {
  const key  = todayWIB();
  const ref  = db.ref(`daily_usage/${uid}/${key}`);
  const snap = await ref.once("value");
  if (!snap.exists()) {
    await ref.set({ chats:0, photos:0, reset_at: now() });
    return { chats:0, photos:0 };
  }
  return snap.val();
}

// ── Auto-cleanup: hapus data usage > 30 hari ──────────────────────────────────
async function cleanupOldUsage(uid) {
  try {
    const cutoff = new Date(Date.now() + 7*3600000 - 30*86400000)
      .toISOString().slice(0,10); // 30 hari lalu (WIB)
    const snap = await db.ref(`daily_usage/${uid}`).once("value");
    if (!snap.exists()) return;
    const updates = {};
    snap.forEach(child => {
      if (child.key < cutoff) updates[child.key] = null; // delete
    });
    if (Object.keys(updates).length > 0) {
      await db.ref(`daily_usage/${uid}`).update(updates);
    }
  } catch {}
}

// ── Cleanup guest analytics > 30 hari ────────────────────────────────────────
async function cleanupGuestAnalytics() {
  try {
    const cutoff30d = Date.now() - 30*86400000;
    const snap = await db.ref("analytics/guests").once("value");
    if (!snap.exists()) return;
    const updates = {};
    snap.forEach(child => {
      const d = child.val();
      if ((d.last_visit||0) < cutoff30d) updates[child.key] = null;
    });
    if (Object.keys(updates).length > 0) {
      await db.ref("analytics/guests").update(updates);
    }
  } catch {}
}

async function incrCounter(uid, field) {
  await db.ref(`daily_usage/${uid}/${todayWIB()}/${field}`).transaction(v => (v||0)+1);
}

async function recordAnalytics(uid, { name, email, ip, sentPhoto, isGuest }) {
  // Guest → analytics/guests (terpisah, auto-delete 30 hari)
  // User login → analytics/traffic
  const path = isGuest
    ? `analytics/guests/${uid}`
    : `analytics/traffic/${uid}`;

  await db.ref(path).transaction(cur => {
    const b = cur || {
      name:              name  || (isGuest ? "Guest" : ""),
      email:             email || "",
      ip_address:        ip    || "",
      is_guest:          !!isGuest,
      first_visit:       now(),
      total_chats_sent:  0,
      total_photos_sent: 0,
    };
    b.name              = name  || b.name;
    b.email             = email || b.email;
    b.ip_address        = ip    || b.ip_address;
    b.last_visit        = now();
    b.total_chats_sent  = (b.total_chats_sent  || 0) + 1;
    b.total_photos_sent = (b.total_photos_sent || 0) + (sentPhoto ? 1 : 0);
    return b;
  });

  // Run cleanup setiap 100 request (probabilistic, biar ringan)
  if (Math.random() < 0.01) {
    if (!isGuest) cleanupOldUsage(uid).catch(()=>{});
    cleanupGuestAnalytics().catch(()=>{});
  }
}

async function pushChat(uid, sessId, role, text, hasImg) {
  await db.ref(`user_sessions/${uid}/${sessId}/chats`).push({ role, text, has_image:!!hasImg, ts:now() });
}

async function ensureSessionMeta(uid, sessId, firstMsg) {
  const ref  = db.ref(`user_sessions/${uid}/${sessId}/meta`);
  const snap = await ref.once("value");
  if (!snap.exists()) await ref.set({ title:firstMsg?.slice(0,50)||"Obrolan Baru", created_at:now() });
  else await ref.child("last_active").set(now());
}

async function getSystemSettings() {
  try {
    const snap = await db.ref("system_settings").once("value");
    return snap.val() || {};
  } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

  // ── AUTH ──────────────────────────────────────────────────────────────────
  let uid = "GUEST_" + ip.replace(/[.:]/g,"_");
  let uName="Guest", uEmail="", isGuest=true;

  const token = (req.headers["authorization"]||"").replace("Bearer ","").trim();
  if (token) {
    try {
      const dec  = await auth.verifyIdToken(token);
      uid        = dec.uid;
      uName      = dec.name  || dec.email?.split("@")[0] || "User";
      uEmail     = dec.email || "";

      // Validate domain
      const domain = uEmail.split("@")[1]?.toLowerCase();
      if (!["gmail.com","googlemail.com"].includes(domain)) {
        return res.status(403).json({ error:"Forbidden", reason:"Hanya akun Google (@gmail.com) yang diizinkan." });
      }
      isGuest = false;
    } catch {
      uid = "GUEST_" + ip.replace(/[.:]/g,"_");
    }
  }

  // ── SYSTEM SETTINGS ───────────────────────────────────────────────────────
  const sysCfg = await getSystemSettings();

  if (sysCfg.maintenance_mode) {
    return res.status(503).json({ response:"Sistem sedang maintenance bro, coba lagi nanti ya!", reason:"maintenance" });
  }
  if (sysCfg.login_required && isGuest) {
    return res.status(403).json({ response:"Kamu harus login dulu untuk menggunakan XREZZKY AI!", reason:"login_required" });
  }

  // ── USER CONFIG ───────────────────────────────────────────────────────────
  const userCfg = await ensureUserConfig(uid, isGuest ? "GUEST" : "MEMBER");
  const { role, max_chat_limit, max_photo_limit } = userCfg;

  // ── GET — init / debug ────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { action, sess } = req.query;

    if (action === "debug") {
      // ── Cek env vars ─────────────────────────────────
      const env = {
        OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:✓` : `key${i}:✗`),
        GROQ:       [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]        ? `key${i}:✓` : `key${i}:✗`),
        GEMINI_DIRECT: "DISABLED — gunakan model google/* via OpenRouter",
        SEARCH:     process.env.GOOGLE_SEARCH_API_KEY ? "✓ ada" : "✗ kosong",
        FIREBASE:   process.env.FIREBASE_PROJECT_ID   ? "✓ ada" : "✗ kosong",
      };

      // ── Test system prompt ────────────────────────────
      let promptStatus = "gagal";
      try {
        const p = await fetchSystemPrompt();
        promptStatus = p ? `OK ✓ (${p.length} chars)` : "kosong — pakai default";
      } catch(e) { promptStatus = "error: " + e.message; }

      // ── Live test providers ───────────────────────────
      const testMsg = "Balas hanya dengan kata: OK";
      const testSP  = "Kamu asisten. Balas hanya: OK";
      const liveTest = {};

      // Test OpenRouter
      const orK = pick(getKeys("OPENROUTER_API_KEY"));
      if (orK) {
        try {
          await callOpenRouter(orK, "google/gemini-2.0-flash-001", testSP, testMsg, null);
          liveTest["OR/gemini-2.0-flash"] = "✓ OK";
        } catch(e) { liveTest["OR/gemini-2.0-flash"] = "✗ " + e.message.slice(0,100); }

        try {
          await callOpenRouter(orK, "deepseek/deepseek-chat", testSP, testMsg, null);
          liveTest["OR/deepseek-v3"] = "✓ OK";
        } catch(e) { liveTest["OR/deepseek-v3"] = "✗ " + e.message.slice(0,100); }

        try {
          await callOpenRouter(orK, "anthropic/claude-3-haiku", testSP, testMsg, null);
          liveTest["OR/claude-3-haiku"] = "✓ OK";
        } catch(e) { liveTest["OR/claude-3-haiku"] = "✗ " + e.message.slice(0,100); }

        try {
          await callOpenRouter(orK, "meta-llama/llama-3.1-8b-instruct:free", testSP, testMsg, null);
          liveTest["OR/llama-free"] = "✓ OK";
        } catch(e) { liveTest["OR/llama-free"] = "✗ " + e.message.slice(0,100); }
      } else {
        liveTest["OpenRouter"] = "✗ tidak ada key";
      }

      // Test Groq
      const grK = pick(getKeys("GROQ_API_KEY"));
      if (grK) {
        try {
          await callGroq(grK, "llama-3.3-70b-versatile", testSP, testMsg);
          liveTest["Groq/llama-3.3-70b"] = "✓ OK";
        } catch(e) { liveTest["Groq/llama-3.3-70b"] = "✗ " + e.message.slice(0,100); }

        try {
          await callGroq(grK, "llama-3.1-8b-instant", testSP, testMsg);
          liveTest["Groq/llama-3.1-8b"] = "✓ OK";
        } catch(e) { liveTest["Groq/llama-3.1-8b"] = "✗ " + e.message.slice(0,100); }
      } else {
        liveTest["Groq"] = "✗ tidak ada key";
      }

      liveTest["Gemini Direct"] = "DISABLED (sengaja dinonaktifkan)";

      return res.status(200).json({
        status:          "XREZZKY AI aktif",
        timestamp_WIB:   nowStringWIB(),
        all_timezones:   nowAllZones(),
        env_keys:        env,
        github_prompt:   promptStatus,
        provider_test:   liveTest,
        active_queue:    buildQueue(false).map(p => p.name),
        system_settings: sysCfg,
      });
    }

    // ── Simple ping ────────────────────────────────────
    if (action === "ping") {
      return res.status(200).json({ status:"ok", ts:nowStringWIB() });
    }

    // Init session data
    const counter = await getDailyCounter(uid).catch(()=>({chats:0,photos:0}));
    let chats=[]; let allSessions=[];

    if (sess) {
      try {
        const s=await db.ref(`user_sessions/${uid}/${sess}/chats`).once("value");
        if(s.exists()){ chats=Object.values(s.val()).sort((a,b)=>a.ts-b.ts); }
      } catch {}
    }
    try {
      const s=await db.ref(`user_sessions/${uid}`).once("value");
      if(s.exists()){
        s.forEach(c=>{
          const m=c.val()?.meta||{};
          allSessions.push({id:c.key,title:m.title||"Obrolan",created_at:m.created_at||0,last_active:m.last_active||m.created_at||0});
        });
        allSessions.sort((a,b)=>b.last_active-a.last_active);
      }
    } catch {}

    return res.status(200).json({
      uid,
      name:          uName,
      email:         uEmail,
      role,
      used_chat:     counter.chats  || 0,
      used_photo:    counter.photos || 0,
      max_chat_limit,
      max_photo_limit,
      allow_guest_photos: sysCfg.allow_guest_photos ?? false,
      login_required:     sysCfg.login_required     ?? false,
      maintenance_mode:   sysCfg.maintenance_mode   ?? false,
      chats,
      all_sessions: allSessions,
    });
  }

  // ── POST — chat ───────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const { user_message="", user_image=null, sess:sessId } = req.body || {};
    const hasPhoto = !!(user_image?.includes(","));

    // Rate limit checks
    const counter = await getDailyCounter(uid).catch(()=>({chats:0,photos:0}));

    // OWNER & ADMIN tidak punya limit
    const isUnlimited = UNLIMITED_ROLES.includes(role);

    if (!isUnlimited && (counter.chats||0) >= max_chat_limit && max_chat_limit > 0) {
      return res.status(429).json({ reason:"Kapasitas chat harian kamu sudah habis! Tunggu besok atau upgrade akun.", used_chat:counter.chats, max_chat_limit });
    }
    if (hasPhoto) {
      if (isGuest && !sysCfg.allow_guest_photos) {
        return res.status(429).json({ reason:"Guest tidak bisa kirim foto. Login dulu ya!" });
      }
      if (!isUnlimited && (counter.photos||0) >= max_photo_limit && max_photo_limit > 0) {
        return res.status(429).json({ reason:"Limit kirim foto kamu hari ini sudah habis!" });
      }
    }
    if (["BANNED","STOPPED"].includes(role)) {
      return res.status(403).json({ reason:role==="BANNED"?"Akun kamu telah dibanned oleh Admin.":"Akun kamu dihentikan sementara oleh Admin." });
    }

    // ── Fetch system prompt ──────────────────────────────────────────────────
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const p = await fetchSystemPrompt();
      if (p) {
        // Custom prompt dari GitHub ditambahkan SETELAH rules utama
        // Rules utama selalu menang karena posisinya pertama
        systemPrompt = DEFAULT_SYSTEM_PROMPT + "\n\n--- KONTEKS TAMBAHAN ---\n" + p;
      }
    } catch {}

    // ── CATATAN PENTING — tetap fleksibel, gak kaku ──
    systemPrompt += `

--- CATATAN TAMBAHAN ---
- Kalau user cuma menyapa singkat (halo, hai, p, test), balas santai dan singkat aja — gak perlu jelasin semua yang bisa kamu bantu.
- Untuk pertanyaan teknis/coding/belajar, jelasin selengkap yang dibutuhkan tanpa dibatasi panjangnya.
- Gak usah sebut nama model AI atau provider ke user.
- PALING PENTING: kalau ada history percakapan di atas, GUNAKAN untuk paham konteks. Jangan jawab seolah-olah ini pertanyaan pertama kalau sebenarnya nyambung sama obrolan sebelumnya.`;

    // ── Datetime injection — semua zona waktu ────────────────────────────────
    const zones = nowAllZones();
    systemPrompt = `${systemPrompt}

[INFORMASI WAKTU SAAT INI — Gunakan HANYA jika user bertanya tentang waktu/tanggal/hari]:
- WIB  (UTC+7, Indonesia Barat  — Jawa, Sumatra, Kalimantan Barat): ${zones.WIB}
- WITA (UTC+8, Indonesia Tengah — Bali, Sulawesi, Kalimantan Timur): ${zones.WITA}
- WIT  (UTC+9, Indonesia Timur  — Maluku, Papua):                    ${zones.WIT}
- Singapura (UTC+8):   ${zones.Singapore}
- Tokyo (UTC+9):       ${zones.Tokyo}
- Dubai (UTC+4):       ${zones.Dubai}
- London (UTC+0/+1):   ${zones.London}
- New York (UTC-5/-4): ${zones.NewYork}
- Sydney (UTC+10/+11): ${zones.Sydney}

ATURAN: Jangan pernah menyebut waktu secara spontan. Hanya jawab jika ditanya.`;

    // ── Math booster ─────────────────────────────────────────────────────────
    if (needsMath(user_message)) {
      systemPrompt += `\n\n[MODE MATEMATIKA AKTIF]: Kerjakan soal dengan teliti. Tampilkan langkah-langkah penyelesaian secara sistematis. Gunakan notasi yang jelas. Verifikasi jawaban sebelum menyampaikan.`;
    }

    // ── Web search ───────────────────────────────────────────────────────────
    let searchResults = null;
    let didSearch = false;
    if (!hasPhoto && needsSearch(user_message)) {
      try {
        searchResults = await webSearch(user_message);
        if (searchResults) {
          didSearch = true;
          systemPrompt += `\n\n[HASIL PENCARIAN WEB — gunakan untuk menjawab]:\n${searchResults}\n\nBerikan jawaban berdasarkan hasil pencarian di atas. Sebutkan sumber jika relevan.`;
        }
      } catch {}
    }

    // ── Deteksi pesan pendek → tambah instruksi ringkas ─────────────────────
    const msgLen  = (user_message || "").trim().length;
    const isShort = msgLen > 0 && msgLen <= 10;
    const isGreeting = /^(halo|hai|hi|hey|hello|p|ok|oke|test|coba|ping|yo|sup)$/i.test((user_message||"").trim());

    if (isGreeting && history.length === 0) {
      // Hanya kasih instruksi khusus kalau ini BENAR-BENAR awal obrolan
      systemPrompt += `\n\n[Catatan: user baru menyapa di awal obrolan] Balas santai dan singkat, gak usah list kemampuan kamu.`;
    } else if (isGreeting && history.length > 0) {
      // Kalau udah ada history, sapaan singkat = lanjutan obrolan biasa
      systemPrompt += `\n\n[Catatan: ini lanjutan obrolan, bukan awal baru] Cek history di atas buat tahu konteksnya.`;
    }

    // ── Build final user message ──────────────────────────────────────────────
    const finalMsg = user_message || (hasPhoto ? "Analisis gambar ini." : "");

    // ── Ambil history percakapan dari Firebase (max 20 pesan terakhir) ────────
    // INI YANG PALING PENTING — tanpa ini AI tidak akan ingat konteks sebelumnya
    let history = [];
    if (sessId) {
      try {
        const histSnap = await db.ref(`user_sessions/${uid}/${sessId}/chats`).once("value");
        if (histSnap.exists()) {
          const all = Object.values(histSnap.val());
          all.sort((a,b) => (a.ts||0) - (b.ts||0));
          // Ambil 20 pesan terakhir (sebelum pesan yang baru dikirim ini)
          history = all.slice(-20).map(h => ({
            role: h.role === "bot" ? "bot" : "user",
            text: h.text || (h.has_image ? "[gambar]" : ""),
          }));
        }
      } catch(e) { console.warn("History fetch:", e.message); }
    }

    // ── Call AI ───────────────────────────────────────────────────────────────
    const queue     = buildQueue(hasPhoto, history);
    let aiReply     = null;
    let usedProvider= null;
    let lastErr     = null;

    for (const p of queue) {
      try {
        aiReply = await p.fn(systemPrompt, finalMsg, user_image);
        if (aiReply) { usedProvider = p.name; break; }
      } catch(e) {
        console.error(`[${p.name}]`, e.message);
        lastErr = e.message;
      }
    }

    if (!aiReply) {
      const orCount = getKeys("OPENROUTER_API_KEY").length;
      const grCount = getKeys("GROQ_API_KEY").length;
      const hint = orCount === 0 && grCount === 0
        ? "Tidak ada API key OpenRouter atau Groq yang terdaftar di env vars!"
        : `Semua ${queue.length} provider gagal. Error terakhir: ${lastErr}`;
      return res.status(500).json({
        response: `❌ XREZZKY AI tidak bisa menjawab sekarang bro.

${hint}

Coba lagi dalam beberapa detik ya 🙏`,
        error:    lastErr,
        hint,
      });
    }

    // ── Increment counters ────────────────────────────────────────────────────
    try { await incrCounter(uid, "chats"); } catch {}
    if (hasPhoto) { try { await incrCounter(uid, "photos"); } catch {} }

    // ── Save to Firebase ──────────────────────────────────────────────────────
    if (sessId) {
      try {
        await ensureSessionMeta(uid, sessId, user_message);
        await pushChat(uid, sessId, "user", user_message||"[foto]", hasPhoto);
        await pushChat(uid, sessId, "bot",  aiReply, false);
      } catch(e) { console.error("Save session:", e.message); }
    }

    // ── Analytics ─────────────────────────────────────────────────────────────
    try { await recordAnalytics(uid, { name:uName, email:uEmail, ip, sentPhoto:hasPhoto, isGuest }); } catch {}

    // ── Read updated counter ──────────────────────────────────────────────────
    const updated = await getDailyCounter(uid).catch(()=>counter);

    return res.status(200).json({
      response:       aiReply,
      provider:       usedProvider,
      searched:       didSearch,
      used_chat:      updated.chats  || 0,
      used_photo:     updated.photos || 0,
      max_chat_limit,
      max_photo_limit,
      role,
    });
  }

  return res.status(405).json({ error:"Method Not Allowed" });
}
