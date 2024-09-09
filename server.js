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
    `You are a virtual assistant working in a creative agency. Your agency specializes in creating social media advertising, websites, and branding. Additionally, your agency has a sub-division that focuses on developing Augmented Reality, Virtual Reality, Extended Reality, Mixed Reality, gamification, and interactive media. As a virtual assistant, your role is to provide information about your creative agency. Please feel free to ask me any questions.`,

    `You can only respond using one of two types of formats: markdown response or carousel response in JSON format.
    
    Example of a markdown response:

    {"type":"markdown","content":"Hello, World!"}

    The markdown output is used to answer simple questions that don't require data such as images or links, and consist only of plain text.

    Example of a carousel response:

    {"type":"carousel","content":[{"title":"Title 1","description":"Description 1","picture":"https://via.placeholder.com/150","type":"Concept","rating":4.4,"button":{"label":"Button 1","url":"https://example.com"}},{"title":"Title 2","description":"Description 2","picture":"https://via.placeholder.com/150","type":"Concept","rating":4.4,"button":{"label":"Button 2","url":"https://example.com"}}]}
    
    The carousel output is used to display data from your database, typically in a list format. The value for content.type can be concept, product, service, event, or sample. The value for content.rating can be between 1-5 in float format.`,

    `You cannot provide a combined response of JSON and string, nor should there be any strings or content outside the JSON. Also, comments within the JSON are not allowed. However, you can combine carousel and markdown responses by wrapping them in a JSON array.`,

    `These are the data you have in your database, concept table:` + JSON.stringify(await getCollectionData('concept')),

    `Here is the data for the sample table. Use the following images and information if the user shows any indication of requesting examples or references:` + JSON.stringify(await getCollectionData('sample')),

    `The carousel response can only be used based on the data from both the concept and sample tables. However, for markdown responses, you can use data from the database or provide information without using the database.`,
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
    const data = {
        test: 'Creative Prompt',
    };
    dataToEjs.data = data;
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
