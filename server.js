import express from 'express';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsonrepair } from 'jsonrepair'
import { readFileSync } from 'fs';
import { URL } from 'url';

dotenv.config();

const appDebug = process.env.APP_DEBUG === 'true';
const botPicture = process.env.BOT_PICTURE ?? '/assets/img/elements/1.jpg';
const appUrl = process.env.APP_URL ?? '';

// Check if BOT_PICTURE is a valid URL
const finalBotPicture = isValidUrl(botPicture) ? botPicture : `${appUrl}${botPicture}`;

const dataToEjs = { 
    app_name: process.env.APP_NAME ?? 'Creative Prompt',
    asset_url: process.env.ASSET_URL ?? '',
    app_url: appUrl,
    app_debug: appDebug ?? false,
    app_env: process.env.APP_ENV ?? 'production',
    bot_name: process.env.BOT_NAME ?? 'CreatiBot',
    bot_picture: finalBotPicture,
    bot_role: process.env.BOT_ROLE ?? 'Creative Business Analyst',
    bot_description: process.env.BOT_DESCRIPTION ?? 'Your personal creative agency assistant, helping you with your creative needs for your business.',
    bot_status: process.env.BOT_STATUS ?? 'online',
};

// Read the Firebase service account JSON file path from environment variable
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;

// Read and parse the service account JSON file
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

// Firebase Admin SDK Initialization
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Express app
const app = express();

// Set the view engine to EJS
app.set('view engine', 'ejs');

// Set the views directory
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());

// Constants
const LLM_API_BASE_URL = process.env.LLM_API_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || 'gsk_yourgroqapikeyhere';
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL;
const LLM_STREAMING = process.env.LLM_STREAMING !== 'no';

// Function to check if a string is a valid URL
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}


// Chat Function (asynchronous)
const chat = async (messages, handler) => {
    const url = `${LLM_API_BASE_URL}/chat/completions`;
    const auth = LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {};
    const model = LLM_CHAT_MODEL || 'llama-3.1-8b-instant';
    const max_tokens = 1000;
    const temperature = 0;
    const stream = LLM_STREAMING && typeof handler === 'function';

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ messages, model, max_tokens, temperature, stream })
    });

    if (!response.ok) {
        throw new Error(`HTTP error with the status: ${response.status} ${response.statusText}`);
    }

    if (!stream) {
        const data = await response.json();
        const { choices } = data;
        const first = choices[0];
        const { message } = first;
        const { content } = message;
        const answer = content.trim();
        handler && handler(answer);
        return answer;
    }

    const parse = (line) => {
        let partial = null;
        const prefix = line.substring(0, 6);
        if (prefix === 'data: ') {
            const payload = line.substring(6);
            try {
                const { choices } = JSON.parse(payload);
                const [choice] = choices;
                const { delta } = choice;
                partial = delta?.content;
            } catch (e) {
                // ignore
            } finally {
                return partial;
            }
        }
        return partial;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let answer = '';
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n');
        for (let i = 0; i < lines.length; ++i) {
            const line = buffer + lines[i];
            if (line[0] === ':') {
                buffer = '';
                continue;
            }
            if (line === 'data: [DONE]') break;

            if (line.length > 0) {
                const partial = parse(line);
                if (partial === null) {
                    buffer = line;
                } else if (partial && partial.length > 0) {
                    buffer = '';
                    if (answer.length < 1) {
                        const leading = partial.trim();
                        answer = leading;
                        handler && leading.length > 0 && handler(leading);
                    } else {
                        answer += partial;
                        handler && handler(partial);
                    }
                }
            }
        }
    }
    return answer;
};

// Chat Reply Function
let CONTEXT = [
    `Kamu adalah virtual assistant yang bekerja pada bidang creative agency, creative agency kamu bekerja pada pembuatan social media advertising, website, dan juga branding. creative agency kamu juga memiliki sub divisi yang bekerja pada pembuatan Augmented reality, Virtual reality, extended reality, mixed reality, gamification, dan juga interactive media. Kamu adalah asisten virtual yang akan membantu dalam memberikan informasi mengenai creative agency kamu. Silahkan bertanya kepada saya.`,

    `kamu hanya bisa menjawab dengan salah satu dari 2 jenis respon, yaitu respon menggunakan markdown dan carousel dengan format json.
    
    contoh untuk respon menggunakan markdown:

    {"type":"markdown","content":"Hello, World!"}

    output dengan jenis markdown digunakan untuk menjawab pertanyaan yang sederhana tanpa memerlukan data seperti gambar atau link, dan hanya berupa teks biasa.


    contoh untuk respon menggunakan carousel:

    {"type":"carousel","content":[{"title":"Title 1","description":"Description 1","picture":"https://via.placeholder.com/150","type":"Concept","rating":4.4,"button":{"label":"Button 1","url":"https://example.com"}},{"title":"Title 2","description":"Description 2","picture":"https://via.placeholder.com/150","type":"Concept","rating":4.4,"button":{"label":"Button 2","url":"https://example.com"}}]}
    
    output dengan jenis carousel digunakan untuk menampilkan data-data yang kamu miliki dalam database, dan biasanya bersifat list. Untuk value content.type bisa concept, product, service, event dan sample. Untuk value content.rating bisa 1-5 format float.
    `,

    `kamu tidak bisa memberikan respon gabungan antara json dan string, dan juga tidak boleh ada string atau apapun di luar json, dan juga tidak boleh ada komentar di dalam json. Tetapi kamu bisa menggabungkan carousel dan markdown dengan membungkusnya dalam array json.`,

    `ini data-data yang kamu miliki dalam database, tabel concept:` + JSON.stringify(await getCollectionData('concept')),

    `berikut data data untuk, tabel sample atau contoh, gunakan gambar dan beberapa informasi berikut jika user terdapat indikasi untuk meminta contoh atau referensi:` + JSON.stringify(await getCollectionData('sample')),

    `respon untuk carousel hanya bisa digunakan berdasarkan kedua data pada tabel concept dan sample, tetapi untuk markdown bisa menggunakan data dari database atau tidak menggunakan data dari database.`,

    // `response yang saya harapkan adalah salah satu 2 tipe diatas, kamu tidak bisa mencampurkan 2 tipe response dalam 1 jawaban, dan juga tidak boleh ada string atau apapun di luar json, dan juga tidak boleh ada komentar di dalam json.`,

    // `secara default, kamu menjawab dalam bentuk markdown, markdown digunakan untuk menjawab pertanyaan yang sederhana yang tidak memiliki datanya di database, berikan output dalam bentuk carousle jika user meminta suatu sample atau data yang kamu miliki dalam database dan biasanya bersifat list`,

    // `kamu hanya menjawab dalam bentuk carousel untuk menampilkan data-data yang kamu miliki dalam database, dan markdown untuk menjawab pertanyaan yang sederhana yang tidak memiliki datanya di database.`,
];

const reply = async (context) => {
    const { inquiry, history, stream } = context;

    const messages = [];
    for (let i = 0; i < CONTEXT.length; i++) {
        messages.push({ role: 'system', content: CONTEXT[i] });
    }
    const relevant = history.slice(-4);
    relevant.forEach((msg) => {
        const { inquiry, answer } = msg;
        messages.push({ role: 'user', content: inquiry });
        messages.push({ role: 'assistant', content: answer });
    });
    messages.push({ role: 'user', content: inquiry });
    // console.log(messages);
    const answer = await chat(messages, stream);

    return { answer, ...context };
};

function getCollectionData(collection) {
    return new Promise((resolve, reject) => {
        db.collection(collection).get()
            .then(snapshot => {
                const data = snapshot.docs.map(doc => doc.data());
                resolve(data);
            })
            .catch(reject);
    });
}

// Routes

app.get('/', (req, res) => {
    res.render('landingpage', dataToEjs);
});

app.get('/chatroom', (req, res) => {
    res.render('chatroom', dataToEjs);
});

app.post('/chat', async (req, res) => {
    const { inquiry, history } = req.body;
    res.writeHead(200, { 'Content-Type': 'text/plain' });

    const stream = (part) => res.write(part);
    const context = { inquiry, history, stream };
    const start = Date.now();
    const result = await reply(context);

    const duration = Date.now() - start;
    res.end();

    // Repair JSON with jsonrepair
    try {
        // Ensure result is a string
        let resultString = typeof result === 'string' ? result : JSON.stringify(result);
        
        // Repair the JSON string
        const repairedJson = jsonrepair(resultString);
        
        // Parse the repaired JSON string
        const { answer } = JSON.parse(repairedJson);
        
        // console.log('Repaired and parsed JSON:', answer);
    } catch (err) {
        console.error('Failed to repair or parse JSON:', err);
    }
});

// buat app get /firebase untuk mendapatkan data dari firestore pada collection `concept`
app.get('/firebase/concept', async (req, res) => {
    const data = await getCollectionData('concept');
    res.json(data);
});

// buat app get /firebase untuk mendapatkan data dari firestore pada collection `sample`
app.get('/firebase/sample', async (req, res) => {
    const data = await getCollectionData('sample');
    res.json(data);
});

// buat app get /context untuk mendapatkan context llm
app.get('/context', async (req, res) => {
    const messages = [];
    for (let i = 0; i < CONTEXT.length; i++) {
        messages.push({ role: 'system', content: CONTEXT[i] });
    }
    res.json(messages);
});

// Start Server
// Define environment variables for IP and port
const ip = process.env.APP_IP || '127.0.0.1';
const port = process.env.APP_PORT || 3000;

app.listen(port, ip, () => {
    console.log(`Server running at http://${ip}:${port}/`);
});
