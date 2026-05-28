import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/generative-ai';

// Inisialisasi Supabase aman
function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
}

// Load Balancer API Key Gemini cadanganmu
function getGeminiKey() {
    const keys = [];
    if (process.env.GEMINI_API_KEY_1) keys.push(process.env.GEMINI_API_KEY_1);
    if (process.env.GEMINI_API_KEY_2) keys.push(process.env.GEMINI_API_KEY_2);
    
    if (keys.length === 0) return null;
    return keys[Math.floor(Math.random() * keys.length)];
}

export default async function handler(req, res) {
    // Pengaturan CORS Headers lengkap agar frontend & admin panel lancar koneksinya
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { action } = req.query;
    const supabase = getSupabase();

    // ==========================================
    // 1. LOGIKA UNTUK MENAMPILKAN DATA (GET)
    // ==========================================
    if (req.method === 'GET' || action === 'get_context') {
        if (!supabase) {
            return res.status(500).json({ error: "Koneksi Supabase gagal. Cek Env Vercel." });
        }
        try {
            const { data, error } = await supabase
                .from('info_toko')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ data: data });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // ==========================================
    // 2. LOGIKA UNTUK TRANSAKSI DATA (POST)
    // ==========================================
    if (req.method === 'POST') {
        // AKSYON A: Jika admin ingin menyimpan konteks baru
        if (action === 'save_context') {
            if (!supabase) return res.status(500).json({ error: "Supabase belum siap." });
            try {
                const { kategori, judul, content } = req.body;
                const { data, error } = await supabase
                    .from('info_toko')
                    .insert([{ kategori, judul, content }]);

                if (error) throw error;
                return res.status(200).json({ success: true, data });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // AKSYON B: Jika request datang dari halaman Chat utama (Fitur Utama Chat AI)
        try {
            const { user_message, user_image } = req.body;

            // Suntik data dari database info_toko untuk memori AI
            let knowledgeContext = "";
            if (supabase) {
                try {
                    const { data: infoToko } = await supabase.from('info_toko').select('content').limit(10);
                    if (infoToko) knowledgeContext = infoToko.map(item => item.content).join("\n");
                } catch (e) {
                    console.error("Gagal membaca database:", e);
                }
            }

            const activeApiKey = getGeminiKey();
            if (!activeApiKey) {
                return res.status(500).json({ response: "Error: API Key Gemini tidak terdeteksi." });
            }

            const ai = new GoogleGenAI({ apiKey: activeApiKey });
            const systemPrompt = `Kamu adalah XREZZ AI, asisten resmi XREZZKY OFFICIAL STORE.
Gunakan data resmi toko di bawah ini untuk menjawab pelanggan:
${knowledgeContext || "Nama Toko: XREZZKY OFFICIAL STORE. Melayani top up game dan kebutuhan gamers terpercaya."}

Aturan: Jawab santai ala anak muda/gamers, gunakan sebutan 'bro' atau 'kak'.`;

            const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
            let promptContents = [];

            if (user_image && user_image.includes(",")) {
                try {
                    const parts = user_image.split(",");
                    const mimeType = parts[0].match(/:(.*?);/)[1] || "image/jpeg";
                    const base64Data = parts[1];
                    promptContents.push({ inlineData: { data: base64Data, mimeType: mimeType } });
                } catch (imgErr) {
                    console.error("Gagal convert gambar:", imgErr);
                }
            }

            promptContents.push({ text: `${systemPrompt}\n\nUser: ${user_message || "Halo"}` });

            const result = await model.generateContent({ contents: promptContents });
            return res.status(200).json({ response: result.response.text() });

        } catch (error) {
            return res.status(500).json({ response: "Server sedang sibuk, coba kirim chat lagi bro.", error: error.message });
        }
    }

    return res.status(405).json({ error: 'Method tidak diizinkan' });
}
