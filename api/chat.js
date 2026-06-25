// ═══════════════════════════════════════════════════════════════════════════
//  XREZZKY AI — api/chat.js  (Vercel Serverless)
//  Fitur: AI Multi-Provider · Web Search · Analisis Gambar
//         Konteks Percakapan · Role-based Limits dari Firebase
// ═══════════════════════════════════════════════════════════════════════════

import admin from "firebase-admin";

// ── Firebase Admin SDK init ────────────────────────────────────────────────
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
//  KONSTANTA & KONFIGURASI
// ═══════════════════════════════════════════════════════════════════════════
const GITHUB_RAW = "https://raw.githubusercontent.com/xrezzkystoreidn/xrezzky-assistant/main/prompt";

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

function nowAllZones() {
  const ts = Date.now();
  const f  = (tz, loc="id-ID") => new Date(ts).toLocaleString(loc, {
    weekday:"short", day:"numeric", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit", timeZone: tz
  });
  return {
    WIB:       f("Asia/Jakarta"),
    WITA:      f("Asia/Makassar"),
    WIT:       f("Asia/Jayapura"),
    London:    f("Europe/London", "en-GB"),
    NewYork:   f("America/New_York", "en-US"),
    Tokyo:     f("Asia/Tokyo", "ja-JP"),
    Dubai:     f("Asia/Dubai", "ar-AE"),
    Sydney:    f("Australia/Sydney", "en-AU"),
    Singapore: f("Asia/Singapore", "en-SG"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  FETCH SYSTEM PROMPT DARI GITHUB (terbaru)
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
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=5&hl=id&dateRestrict=d7&sort=date`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();

    if (!data.items?.length) return null;

    const results = data.items.slice(0, 5).map(item => ({
      title:   item.title,
      snippet: item.snippet?.replace(/\n/g," ") || "",
      link:    item.link,
      date:    item.pagemap?.metatags?.[0]?.["article:published_time"] || "",
    }));

    return results.map((r, i) =>
      `[${i+1}] ${r.title}\n${r.snippet}\nURL: ${r.link}${r.date ? ` · Terbit: ${r.date}` : ''}`
    ).join("\n\n");
  } catch { return null; }
}

// ── Deteksi kebutuhan search ──────────────────────────────────────────────
function needsSearch(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();

  const searchTriggers = [
    "berita", "terbaru", "hari ini", "sekarang", "terkini", "update",
    "harga", "price", "berapa harga", "cuaca", "weather", "jadwal",
    "siapa", "who is", "apa itu", "what is", "kapan", "dimana",
    "cari", "search", "google", "cek", "info", "informasi tentang",
    "trending", "viral", "rilis", "release", "launch", "keluar kapan",
    "film", "lagu", "artis", "game baru", "patch", "update game",
    "nilai tukar", "kurs", "dollar", "bitcoin", "crypto",
    "cara", "tutorial", "bagaimana cara", "how to",
    "fakta", "data", "statistik", "populasi", "luas", "sejarah",
    "presiden", "menteri", "pemilu", "hasil", "skor", "pertandingan"
  ];

  const mathPattern = /[\d\+\-\*\/\^\=\(\)]{3,}|hitung|kalkul|integral|turunan|limit|matriks|persamaan|modulo|pangkat|akar|sin|cos|tan|log/i;
  if (mathPattern.test(m) && !searchTriggers.some(t => m.includes(t))) return false;

  return searchTriggers.some(trigger => m.includes(trigger));
}

function needsMath(msg) {
  if (!msg) return false;
  return /[\d\+\-\*\/\^\=\(\)]{3,}|hitung|kalkul|integral|turunan|limit\s|matriks|persamaan|modulo|pangkat|akar\s|sin\(|cos\(|tan\(|log\(|sigma|kombinasi|permutasi|statistik|mean|median|modus|standar deviasi/i.test(msg);
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI PROVIDERS
// ═══════════════════════════════════════════════════════════════════════════

// ── OpenRouter (vision & teks) ────────────────────────────────────────────
async function callOpenRouter(apiKey, model, systemPrompt, userMessage, userImage, history=[]) {
  let userContent;
  if (userImage?.includes(",")) {
    try {
      const split    = userImage.split(",");
      const mimeType = split[0].match(/:(.*?);/)[1] || "image/jpeg";
      userContent = [
        { type:"image_url", image_url:{ url:`data:${mimeType};base64,${split[1]}` } },
        { type:"text",      text: userMessage || "Deskripsikan gambar ini secara detail." },
      ];
    } catch { userContent = userMessage || "Halo"; }
  } else {
    userContent = userMessage || "Halo";
  }

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

// ── Groq (teks cepat) ──────────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════
//  BUILD QUEUE
// ═══════════════════════════════════════════════════════════════════════════
function buildQueue(hasImage, history=[]) {
  const orKeys = getKeys("OPENROUTER_API_KEY");
  const grKeys = getKeys("GROQ_API_KEY");
  const q = [];

  if (hasImage) {
    if (orKeys.length) {
      const visionModels = [
        "google/gemini-2.0-flash-001",
        "google/gemini-flash-1.5",
        "anthropic/claude-3-haiku",
        "google/gemini-2.5-pro-preview",
        "meta-llama/llama-3.2-11b-vision-instruct:free"
      ];
      for (const model of visionModels) {
        const k = pick(orKeys);
        if (k) q.push({
          name: `OR/${model}`,
          fn: (sp, msg, img) => callOpenRouter(k, model, sp, msg, img, history)
        });
      }
    }
    return q;
  }

  if (orKeys.length) {
    const orModels = [
      "google/gemini-2.0-flash-001",
      "deepseek/deepseek-chat",
      "anthropic/claude-3-haiku",
      "google/gemini-2.5-pro-preview",
      "meta-llama/llama-3.1-8b-instruct:free"
    ];
    for (const model of orModels) {
      const k = pick(orKeys);
      if (k) q.push({
        name: `OR/${model}`,
        fn: (sp, msg) => callOpenRouter(k, model, sp, msg, null, history)
      });
    }
  }

  if (grKeys.length) {
    const grModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    for (const model of grModels) {
      const k = pick(grKeys);
      if (k) q.push({
        name: `Groq/${model}`,
        fn: (sp, msg) => callGroq(k, model, sp, msg, history)
      });
    }
  }

  return q;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FIREBASE DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// ── 🔥 AMBIL ROLE LIMITS DARI FIREBASE ──
async function getRoleLimits() {
  try {
    const snap = await db.ref("system_settings/role_limits").once("value");
    return snap.val() || {};
  } catch {
    return {};
  }
}

// ── 🔥 AMBIL SYSTEM SETTINGS ──
async function getSystemSettings() {
  try {
    const snap = await db.ref("system_settings").once("value");
    return snap.val() || {};
  } catch { return {}; }
}

// ── 🔥 AMBIL LIMIT USER (dengan prioritas: user_config > role_limits) ──
async function getUserLimits(uid, role, userConfig) {
  const roleLimits = await getRoleLimits();
  
  // ADMIN/OWNER unlimited
  if (UNLIMITED_ROLES.includes(role)) {
    return { chatLimit: 99999, photoLimit: 99999 };
  }

  // Cek user_config dulu (bisa diubah admin)
  if (userConfig) {
    const chatLimit = userConfig.max_chat_limit;
    const photoLimit = userConfig.max_photo_limit;
    if (chatLimit !== undefined && photoLimit !== undefined) {
      return { chatLimit, photoLimit };
    }
  }

  // Fallback ke role_limits dari Firebase
  const roleLimit = roleLimits[role] || {};
  const chatLimit = roleLimit.max_chat_limit ?? 10;
  const photoLimit = roleLimit.max_photo_limit ?? 0;

  return { chatLimit, photoLimit };
}

// ── 🔥 AMBIL COUNTER HARIAN ──
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

async function incrCounter(uid, field) {
  await db.ref(`daily_usage/${uid}/${todayWIB()}/${field}`).transaction(v => (v||0)+1);
}

async function ensureUserConfig(uid, defaultRole="MEMBER", meta={}) {
  const ref  = db.ref(`users_config/${uid}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    const roleLimits = await getRoleLimits();
    const rl = roleLimits[defaultRole] || {};
    const cfg = {
      role:            defaultRole,
      max_chat_limit:  rl.max_chat_limit  ?? 10,
      max_photo_limit: rl.max_photo_limit ?? 0,
      name:            meta.name  || "",
      email:           meta.email || "",
      is_anonymous:    meta.is_anonymous || false,
      created_at:      now(),
    };
    await ref.set(cfg);
    return cfg;
  }

  const cfg = snap.val();
  // Update last_login
  await ref.update({ last_login: now() });
  return cfg;
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

async function recordAnalytics(uid, { name, email, ip, sentPhoto, isGuest }) {
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
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";

  // ── AUTH ──────────────────────────────────────────────────────────────────
  let uid = "GUEST_" + ip.replace(/[.:]/g,"_");
  let uName="Guest", uEmail="", isGuest=true, isAnonymous=false;

  const token = (req.headers["authorization"]||"").replace("Bearer ","").trim();
  if (token) {
    try {
      const dec  = await auth.verifyIdToken(token);
      uid        = dec.uid;
      uName      = dec.name  || dec.email?.split("@")[0] || "User";
      uEmail     = dec.email || "";
      isAnonymous = dec.firebase?.sign_in_provider === "anonymous";
      const domain = uEmail.split("@")[1]?.toLowerCase();
      if (!isAnonymous && !["gmail.com","googlemail.com"].includes(domain)) {
        return res.status(403).json({ error:"Forbidden", reason:"Hanya akun Google (@gmail.com) atau Anonymous yang diizinkan." });
      }
      isGuest = isAnonymous;
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
  const defaultRole = isGuest ? "GUEST" : "MEMBER";
  const userCfg = await ensureUserConfig(uid, defaultRole, { name:uName, email:uEmail, is_anonymous:isGuest });
  const role = userCfg.role || defaultRole;

  // ── 🔥 AMBIL LIMIT DARI FIREBASE ──────────────────────────────────────
  const { chatLimit, photoLimit } = await getUserLimits(uid, role, userCfg);

  // ── GET — debug ──────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { action, sess } = req.query;
    if (action === "debug") {
      const env = {
        OPENROUTER: [1,2,3,4,5].map(i => process.env[`OPENROUTER_API_KEY_${i}`] ? `key${i}:✓` : `key${i}:✗`),
        GROQ:       [1,2,3,4,5].map(i => process.env[`GROQ_API_KEY_${i}`]        ? `key${i}:✓` : `key${i}:✗`),
        SEARCH:     process.env.GOOGLE_SEARCH_API_KEY ? "✓ ada" : "✗ kosong",
        FIREBASE:   process.env.FIREBASE_PROJECT_ID   ? "✓ ada" : "✗ kosong",
      };
      let promptStatus = "gagal";
      try {
        const p = await fetchSystemPrompt();
        promptStatus = p ? `OK ✓ (${p.length} chars)` : "kosong — pakai default";
      } catch(e) { promptStatus = "error: " + e.message; }

      const liveTest = {};
      const orK = pick(getKeys("OPENROUTER_API_KEY"));
      if (orK) {
        try {
          await callOpenRouter(orK, "google/gemini-2.0-flash-001", "Kamu asisten. Balas hanya: OK", "test", null);
          liveTest["OR/gemini-2.0-flash"] = "✓ OK";
        } catch(e) { liveTest["OR/gemini-2.0-flash"] = "✗ " + e.message.slice(0,100); }
      } else { liveTest["OpenRouter"] = "✗ tidak ada key"; }

      const grK = pick(getKeys("GROQ_API_KEY"));
      if (grK) {
        try {
          await callGroq(grK, "llama-3.3-70b-versatile", "Kamu asisten. Balas hanya: OK", "test");
          liveTest["Groq/llama-3.3-70b"] = "✓ OK";
        } catch(e) { liveTest["Groq/llama-3.3-70b"] = "✗ " + e.message.slice(0,100); }
      } else { liveTest["Groq"] = "✗ tidak ada key"; }

      return res.status(200).json({
        status:          "XREZZKY AI aktif",
        timestamp_WIB:   new Date(Date.now()+7*3600000).toLocaleString("id-ID", { timeZone:"Asia/Jakarta" }),
        all_timezones:   nowAllZones(),
        env_keys:        env,
        github_prompt:   promptStatus,
        provider_test:   liveTest,
        active_queue:    buildQueue(false).map(p => p.name),
        system_settings: sysCfg,
        user: { uid, role, chatLimit, photoLimit, isGuest }
      });
    }

    if (action === "ping") {
      return res.status(200).json({ status:"ok", ts:new Date(Date.now()+7*3600000).toISOString() });
    }

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
      uid, name: uName, email: uEmail, role,
      used_chat: counter.chats||0, used_photo: counter.photos||0,
      max_chat_limit: chatLimit,
      max_photo_limit: photoLimit,
      allow_guest_photos: sysCfg.allow_guest_photos ?? false,
      login_required: sysCfg.login_required ?? false,
      maintenance_mode: sysCfg.maintenance_mode ?? false,
      chats, all_sessions: allSessions,
    });
  }

  // ── POST — chat ───────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const { user_message="", user_image=null, sess:sessId, history: historyFromFrontend } = req.body || {};
    const hasPhoto = !!(user_image?.includes(","));

    // ── 🔥 RATE LIMIT CHECKS ──────────────────────────────────────────────
    const counter = await getDailyCounter(uid).catch(()=>({chats:0,photos:0}));
    const isUnlimited = UNLIMITED_ROLES.includes(role);

    // 🔥 Cek limit chat
    if (!isUnlimited && (counter.chats||0) >= chatLimit && chatLimit > 0) {
      return res.status(429).json({
        reason: `Kapasitas chat harian kamu sudah habis! (${counter.chats}/${chatLimit}) Tunggu besok atau upgrade akun.`,
        used_chat: counter.chats,
        max_chat_limit: chatLimit
      });
    }

    // 🔥 Cek limit foto
    if (hasPhoto) {
      if (isGuest && !sysCfg.allow_guest_photos) {
        return res.status(429).json({ reason:"Guest tidak bisa kirim foto. Login dulu atau minta admin aktifkan izin guest." });
      }
      if (!isUnlimited && (counter.photos||0) >= photoLimit && photoLimit > 0) {
        return res.status(429).json({
          reason: `Limit kirim foto kamu hari ini sudah habis! (${counter.photos}/${photoLimit})`,
          used_photo: counter.photos,
          max_photo_limit: photoLimit
        });
      }
    }

    // 🔥 Cek role banned/stopped
    if (["BANNED","STOPPED"].includes(role)) {
      return res.status(403).json({ reason:role==="BANNED"?"Akun kamu telah dibanned oleh Admin.":"Akun kamu dihentikan sementara oleh Admin." });
    }

    // ── Fetch system prompt (terbaru dari GitHub) ──────────────────────────
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const p = await fetchSystemPrompt();
      if (p) systemPrompt = DEFAULT_SYSTEM_PROMPT + "\n\n--- KONTEKS TAMBAHAN ---\n" + p;
    } catch {}

    systemPrompt += `

--- CATATAN TAMBAHAN ---
- Kalau user cuma menyapa singkat (halo, hai, p, test), balas santai dan singkat aja — gak perlu jelasin semua yang bisa kamu bantu.
- Untuk pertanyaan teknis/coding/belajar, jelasin selengkap yang dibutuhkan tanpa dibatasi panjangnya.
- Gak usah sebut nama model AI atau provider ke user.
- PALING PENTING: kalau ada history percakapan di atas, GUNAKAN untuk paham konteks. Jangan jawab seolah-olah ini pertanyaan pertama kalau sebenarnya nyambung sama obrolan sebelumnya.`;

    // ── Inject waktu ──────────────────────────────────────────────────────
    const zones = nowAllZones();
    systemPrompt = `${systemPrompt}

[INFORMASI WAKTU SAAT INI — Gunakan HANYA jika user bertanya tentang waktu/tanggal/hari]:
- WIB  (UTC+7, Indonesia Barat): ${zones.WIB}
- WITA (UTC+8, Indonesia Tengah): ${zones.WITA}
- WIT  (UTC+9, Indonesia Timur): ${zones.WIT}
- Singapore (UTC+8): ${zones.Singapore}
- Tokyo (UTC+9): ${zones.Tokyo}
- Dubai (UTC+4): ${zones.Dubai}
- London (UTC+0/+1): ${zones.London}
- New York (UTC-5/-4): ${zones.NewYork}
- Sydney (UTC+10/+11): ${zones.Sydney}

ATURAN: Jangan pernah menyebut waktu secara spontan. Hanya jawab jika ditanya.`;

    // ── Math booster ──────────────────────────────────────────────────────
    if (needsMath(user_message)) {
      systemPrompt += `\n\n[MODE MATEMATIKA AKTIF]: Kerjakan soal dengan teliti. Tampilkan langkah-langkah penyelesaian secara sistematis. Gunakan notasi yang jelas. Verifikasi jawaban sebelum menyampaikan.`;
    }

    // ── Web search ─────────────────────────────────────────────────────────
    let searchResults = null;
    let didSearch = false;
    if (!hasPhoto && needsSearch(user_message)) {
      try {
        searchResults = await webSearch(user_message);
        if (searchResults) {
          didSearch = true;
          systemPrompt += `\n\n[HASIL PENCARIAN WEB — FAKTA LAPANGAN TERBARU]:\n${searchResults}\n\nBerikan jawaban berdasarkan hasil pencarian di atas. Sebutkan sumber jika relevan. Jangan mengarang data, gunakan fakta dari hasil pencarian.`;
        }
      } catch {}
    }

    // ── Ambil history ──────────────────────────────────────────────────────
    let history = [];
    if (historyFromFrontend && Array.isArray(historyFromFrontend)) {
      history = historyFromFrontend.map(h => ({
        role: h.role === 'assistant' ? 'bot' : 'user',
        text: h.content || ''
      }));
    } else if (sessId) {
      try {
        const histSnap = await db.ref(`user_sessions/${uid}/${sessId}/chats`).once("value");
        if (histSnap.exists()) {
          const all = Object.values(histSnap.val());
          all.sort((a,b) => (a.ts||0) - (b.ts||0));
          history = all.slice(-20).map(h => ({
            role: h.role === "bot" ? "bot" : "user",
            text: h.text || (h.has_image ? "[gambar]" : ""),
          }));
        }
      } catch(e) { console.warn("History fetch:", e.message); }
    }

    // ── Call AI ────────────────────────────────────────────────────────────
    const queue = buildQueue(hasPhoto, history);
    let aiReply = null;
    let usedProvider = null;
    let lastErr = null;

    for (const p of queue) {
      try {
        aiReply = await p.fn(systemPrompt, user_message, user_image);
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
        response: `❌ XREZZKY AI tidak bisa menjawab sekarang bro.\n\n${hint}\n\nCoba lagi dalam beberapa detik ya 🙏`,
        error:    lastErr,
        hint,
      });
    }

    // ── Increment counters ──────────────────────────────────────────────────
    try { await incrCounter(uid, "chats"); } catch {}
    if (hasPhoto) { try { await incrCounter(uid, "photos"); } catch {} }

    // ── Save to Firebase ──────────────────────────────────────────────────
    if (sessId) {
      try {
        await ensureSessionMeta(uid, sessId, user_message);
        await pushChat(uid, sessId, "user", user_message||"[foto]", hasPhoto);
        await pushChat(uid, sessId, "bot",  aiReply, false);
      } catch(e) { console.error("Save session:", e.message); }
    }

    // ── Analytics ───────────────────────────────────────────────────────────
    try { await recordAnalytics(uid, { name:uName, email:uEmail, ip, sentPhoto:hasPhoto, isGuest }); } catch {}

    // ── Read updated counter ──────────────────────────────────────────────
    const updated = await getDailyCounter(uid).catch(()=>counter);

    return res.status(200).json({
      response:       aiReply,
      provider:       usedProvider,
      searched:       didSearch,
      used_chat:      updated.chats  || 0,
      used_photo:     updated.photos || 0,
      max_chat_limit: chatLimit,
      max_photo_limit: photoLimit,
      role,
    });
  }

  return res.status(405).json({ error:"Method Not Allowed" });
}
