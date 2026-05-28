import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/generative-ai';

// Fungsi panggil Supabase aman
function initSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
}

// Fungsi Load Balancer API Key
function pickApiKey(provider) {
    const pool = [];
    if (provider === 'gemini') {
        if (process.env.GEMINI_API_KEY_1) pool.push(process.env.GEMINI_API_KEY_1);
        if (process.env.GEMINI_API_KEY_2) pool.push(process.env.GEMINI_API_KEY_2);
    }
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

export default async function handler(req, res) {
    // Set CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { user_message, user_image } = req.body;

        // 1. Ambil konteks dari Supabase info_toko
        let knowledgeBase = "";
        const supabase = initSupabase();
        if (supabase) {
            try {
                const { data } = await supabase.from('info_toko').select('content');
                if (data) knowledgeBase = data.map(d => d.content).join("\n");
            } catch (e) {
                console.error("Supabase Error:", e);
            }
        }

        // 2. Ambil API Key Gemini
        const apiKey = pickApiKey('gemini');
        if (!apiKey) {
            return res.status(500).json({ response: "Error: API Key tidak terdeteksi di server Vercel." });
        }

        // 3. Konfigurasi Google Gen AI
        const ai = new GoogleGenAI({ apiKey: apiKey });
        
        const systemPrompt = `Kamu adalah XREZZ AI, asisten virtual resmi XREZZKY OFFICIAL STORE.
Gunakan data toko berikut untuk menjawab pertanyaan:
${knowledgeBase}

Aturan: Jawab dengan gaya anak muda/gamers, santai, gunakan sebutan 'bro' atau 'kak'.`;

        let modelName = "gemini-1.5-flash"; // Menggunakan model terbaru yang stabil & cepat
        let contents = [];

        // Proteksi parsing gambar base64
        if (user_image && user_image.includes(",")) {
            const parts = user_image.split(",");
            const mimeType = parts[0].match(/:(.*?);/)[1] || "image/jpeg";
            const base64Data = parts[1];
            
            contents.push({
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            });
        }

        contents.push({ text: `${systemPrompt}\n\nUser: ${user_message || "Halo"}` });

        const model = ai.getGenerativeModel({ model: modelName });
        const result = await model.generateContent({ contents });
        const responseText = result.response.text();

        return res.status(200).json({ response: responseText });

    } catch (error) {
        console.error("Fatal Error Handler:", error);
        return res.status(500).json({ 
            response: "Maaf bro, sistem backend sedang overload. Coba kirim pesan lagi.",
            debug: error.message 
        });
    }
}
