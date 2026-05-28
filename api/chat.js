import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/generative-ai';

// Ambil Klien Supabase dengan proteksi cold start Vercel
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        throw new Error("Konfigurasi Supabase URL atau SERVICE_ROLE_KEY tidak ditemukan di Environment Variables.");
    }
    return createClient(url, key);
}

// Fungsi Load Balancer Akurat untuk multi-API Key kamu
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
    // Ambil secara acak dari key yang tersedia agar beban kuota terbagi
    return keys[Math.floor(Math.random() * keys.length)];
}

export default async function handler(req, res) {
    // Pengaturan CORS Header lengkap
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
        const { user_message, user_image } = req.body;

        // 1. Konek Supabase dengan library yang sudah diperbaiki
        const supabase = getSupabaseClient();

        // 2. Tarik Data Knowledge Base Toko dari Supabase
        let knowledgeContext = "";
        try {
            const { data: infoToko, error: dbError } = await supabase
                .from('info_toko')
                .select('content');
            
            if (!dbError && infoToko) {
                knowledgeContext = infoToko.map(item => item.content).join("\n");
            }
        } catch (dbErr) {
            console.error("Gagal mengambil data dari Supabase:", dbErr.message);
        }

        // 3. Ambil Token Gemini lewat fungsi Load Balancer
        const activeGeminiKey = getApiKey('gemini');
        if (!activeGeminiKey) {
            return res.status(500).json({ error: 'API Key Gemini cadangan tidak terbaca di Vercel.' });
        }

        // 4. Inisialisasi Google Gen AI
        const ai = new GoogleGenAI(activeGeminiKey);
        
        const systemInstruction = `Kamu adalah XREZZ AI, asisten virtual resmi dari XREZZKY OFFICIAL STORE.
Tugas kamu adalah membantu calon pembeli/pelanggan menjawab pertanyaan seputar produk game, harga, jam kerja, dan cara transaksi berdasarkan data toko berikut ini:
${knowledgeContext}

Gunakan gaya bahasa anak muda/gamers yang ramah, santai (bisa panggil 'bro', 'kesayangan', atau 'kak'), namun tetap informatif dan terpercaya.`;

        let modelName = "gemini-pro";
        let promptContent = [];

        // Deteksi jika user mengirim gambar (Support Analisis Gambar Jualan/Bukti Transfer)
        if (user_image) {
            modelName = "gemini-pro-vision";
            const base64Data = user_image.split(",")[1] || user_image;
            promptContent.push({
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg"
                }
            });
        }

        const finalPrompt = `${systemInstruction}\n\nPertanyaan User: ${user_message || "Tolong cek dan analisis gambar ini bro"}`;
        promptContent.push(finalPrompt);

        const model = ai.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(promptContent);
        const responseText = result.response.text();

        return res.status(200).json({ response: responseText });

    } catch (error) {
        console.error("Internal Server Error:", error);
        return res.status(500).json({ 
            error: 'Terjadi kesalahan sistem backend.',
            message: error.message 
        });
    }
}
