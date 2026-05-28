import { createClient } from '@supabase/supabase-io'; // atau '@supabase/supabase-js' sesuai package.json kamu
import { GoogleGenAI } from '@google/generative-ai';

// Fungsi untuk inisialisasi Supabase secara aman di dalam runtime Vercel
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error(`Konfigurasi Supabase tidak lengkap. URL: ${url ? 'Ada' : 'Kosong'}, KEY: ${key ? 'Ada' : 'Kosong'}`);
    }
    return createClient(url, key);
}

// Fungsi Load Balancer untuk memilih API Key yang aktif/tersedia
function getApiKey(provider) {
    const keys = [];
    if (provider === 'gemini') {
        if (process.env.GEMINI_API_KEY_1) keys.push(process.env.GEMINI_API_KEY_1);
        if (process.env.GEMINI_API_KEY_2) keys.push(process.env.GEMINI_API_KEY_2);
    } else if (provider === 'groq') {
        if (process.env.GROQ_API_KEY_1) keys.push(process.env.GROQ_API_KEY_1);
        if (process.env.GROQ_API_KEY_2) keys.push(process.env.GROQ_API_KEY_2);
    } else if (provider === 'openrouter') {
        if (process.env.OPENROUTER_API_KEY_1) keys.push(process.env.OPENROUTER_API_KEY_1);
        if (process.env.OPENROUTER_API_KEY_2) keys.push(process.env.OPENROUTER_API_KEY_2);
    }

    if (keys.length === 0) return null;
    // Acak atau pilih key pertama yang tersedia (bisa dikembangkan sesuai kebutuhan load balance)
    return keys[Math.floor(Math.random() * keys.length)];
}

export default async function handler(req, res) {
    // Atur CORS Header agar Frontend bisa mengakses API ini
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Metode tidak diizinkan' });
    }

    try {
        const { user_message, user_image, user_id } = req.body;

        // 1. Ambil Klien Supabase (Dipanggil di dalam handler agar process.env terbaca sempurna)
        const supabase = getSupabaseClient();

        // 2. Cari Knowledge Base / Info Produk dari Supabase info_toko
        let knowledgeContext = "";
        try {
            const { data: infoToko, error: dbError } = await supabase
                .from('info_toko')
                .select('content');
            
            if (!dbError && infoToko) {
                knowledgeContext = infoToko.map(item => item.content).join("\n");
            }
        } catch (dbErr) {
            console.error("Gagal mengambil data Supabase:", dbErr.message);
            // Tetap lanjut meskipun supabase kosong agar AI tidak macet total
        }

        // 3. Ambil API Key Gemini lewat Load Balancer
        const activeGeminiKey = getApiKey('gemini');
        if (!activeGeminiKey) {
            return res.status(500).json({ error: 'API Key Gemini tidak ditemukan di Environment Variables' });
        }

        // 4. Inisialisasi Google Gen AI (Gemini)
        const ai = new GoogleGenAI(activeGeminiKey);
        
        // Atur instruksi sistem agar AI bertindak sebagai asisten tokomu
        const systemInstruction = `Kamu adalah XREZZ AI, asisten resmi dari XREZZKY OFFICIAL STORE. 
Tugasmu adalah membantu pelanggan menjawab pertanyaan mengenai produk, harga, aturan toko, dan layanan berdasarkan data resmi toko berikut ini:
${knowledgeContext}

Jawablah dengan bahasa yang ramah, santai (gunakan panggilan 'bro' atau 'kak' jika cocok), informatif, dan profesional. Jika data tidak ada di context, jawablah dengan pengetahuan umum toko game yang relevan.`;

        // Pilih model Gemini Vision jika ada input gambar, atau Gemini Pro jika hanya teks
        let modelName = "gemini-pro";
        let promptContent = [];

        if (user_image) {
            modelName = "gemini-pro-vision";
            // Ubah Base64 Image menjadi format yang diterima Gemini API
            const base64Data = user_image.split(",")[1] || user_image;
            promptContent.push({
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg"
                }
            });
        }

        // Gabungkan instruksi sistem dan pesan user ke dalam prompt
        const finalPrompt = `${systemInstruction}\n\nUser bertanya: ${user_message || "Minta analisis gambar ini"}`;
        promptContent.push(finalPrompt);

        const model = ai.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(promptContent);
        const responseText = result.response.text();

        // 5. Kembalikan respon sukses ke frontend
        return res.status(200).json({ response: responseText });

    } catch (error) {
        console.error("Sistem Error pada Backend:", error);
        return res.status(500).json({ 
            error: 'Terjadi kesalahan internal pada server.',
            message: error.message 
        });
    }
}
