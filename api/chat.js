import { createClient } from '@supabase/supabase-js';

// 1. Inisialisasi Kredensial (Wajib diisi di Environment Variables Vercel)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  // Atur Header CORS agar bisa diakses oleh frontend dari domain/repository mana pun
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle Preflight Request Browser
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Tolak jika bukan method POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method tidak diizinkan. Gunakan POST.' });
  }

  try {
    const { user_message, user_id } = req.body;

    if (!user_message) {
      return res.status(400).json({ error: 'Pesan user tidak boleh kosong.' });
    }

    // 2. AMBIL DATA SUNTIKAN PEMKIRAN SECARA OTOMATIS DARI SUPABASE MIKMU
    const { data: knowledgeData, error: dbError } = await supabase
      .from('knowledge_base')
      .select('category, title, content');

    if (dbError) throw dbError;

    // 3. RAMU CONTEXT SYSTEM INSTRUCTION (PENGUNCIAN BRANDING XREZZKY OFFICIAL STORE)
    let systemInstruction = "Karakter & Identitas Utama Anda:\n";
    systemInstruction += "Kamu adalah XREZZ AI, kecerdasan buatan resmi dan representasi eksklusif dari XREZZKY OFFICIAL STORE.\n";
    systemInstruction += "Tugas utamamu adalah mengedukasi, melayani, mengarahkan, dan menjawab segala pertanyaan dengan berpusat pada ekosistem bisnis XREZZKY OFFICIAL STORE.\n\n";
    
    systemInstruction += "Aturan Komunikasi & Gaya Bahasa:\n";
    systemInstruction += "- Loyal pada brand XREZZKY OFFICIAL STORE. Pastikan esensi atau nama brand ini disebut secara elegan dalam interaksi.\n";
    systemInstruction += "- Gunakan bahasa Indonesia yang profesional, tegas, percaya diri, namun ramah dan solutif.\n";
    systemInstruction += "- Jika ada pertanyaan di luar konteks platform, belokkan percakapan secara halus kembali ke layanan atau keunggulan XREZZKY OFFICIAL STORE.\n\n";

    systemInstruction += "Berikut adalah data valid dan aturan operasional aktual dari XREZZKY OFFICIAL STORE yang WAJIB kamu jadikan acuan utama:\n\n";

    // Gabungkan data dari database ke dalam ingatan AI
    if (knowledgeData && knowledgeData.length > 0) {
      knowledgeData.forEach((item) => {
        systemInstruction += `[Konteks: ${item.category}] - ${item.title}\n`;
        systemInstruction += `Detail Aturan: ${item.content}\n`;
        systemInstruction += `--------------------------------------------------\n`;
      });
    } else {
      systemInstruction += "(Belum ada data eksternal spesifik yang disuntikkan. Jawablah secara bijak menggunakan persona utama XREZZKY OFFICIAL STORE).\n";
    }

    systemInstruction += "\nPERINTAH TEGAS: Jawab pertanyaan user dengan padat, jelas, akurat berdasarkan data di atas, dan hindari memberikan jawaban asumsi di luar informasi resmi tersebut.";

    // 4. KIRIM PAYLOAD KE API GEMINI PROVIDER
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: user_message }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          temperature: 0.3, // Rendah agar AI disiplin mengikuti aturan suntikan di database
          maxOutputTokens: 1000
        }
      })
    });

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      throw new Error(`Gemini API Error: ${errText}`);
    }

    const geminiResult = await geminiResponse.json();
    
    // Parsing jawaban teks dari JSON response Gemini
    const aiReply = geminiResult.candidates[0].content.parts[0].text;

    // 5. SIMPAN LOG HISTORY CHAT KE SUPABASE SEBAGAI RIWAYAT
    await supabase
      .from('ai_chat_history')
      .insert([
        { 
          user_id: user_id || 'guest_user', 
          message: user_message, 
          response: aiReply 
        }
      ]);

    // 6. LEMPAR RESPON AKHIR KE FRONTEND CHAT WEB
    return res.status(200).json({ response: aiReply });

  } catch (error) {
    console.error("Backend Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
