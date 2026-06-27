const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- HARDCODED CLOUDINARY CONFIGURATION ---
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- CHAT & AUTH DATABASE CONFIG (JSONBIN) ---
const JSONBIN_MASTER_KEY = "$2a$10$d3I8WtKsHo9rGbNCZ..7meshIr35VlIuJazxNWQCaHfesns.oNZhq";
const JSONBIN_BIN_ID = "6a3d75f6f5f4af5e293079fc";

async function getChatDB() {
    const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
    });
    const data = await response.json();
    let record = data.record || {};
    if (!record.users) record.users = [];
    if (!record.messages) record.messages = [];
    return record;
}

async function saveChatDB(record) {
    await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': JSONBIN_MASTER_KEY
        },
        body: JSON.stringify(record)
    });
}

// 1. Health Check Route
app.get('/', (req, res) => {
    res.send('✅ Cloudinary Node.js Server + Chat API is Running!');
});

// 2. Fetch Feed & Search Route (FIXED: Isolated content and optimized loading)
app.get('/api/feed', async (req, res) => {
    try {
        const searchTag = req.query.search;
        // FIX: Only fetch images explicitly uploaded by this app (Stops random Cloudinary images)
        let expression = 'resource_type:image AND tags="pinterest_app"';

        if (searchTag) {
            expression += ` AND tags="${searchTag}"`;
        }
        
        const result = await cloudinary.search
            .expression(expression)
            .sort_by('uploaded_at', 'desc')
            .max_results(50)
            .with_field('tags')
            .execute();
        
        // FIX: Inject Cloudinary optimization parameters for speed (w_400,q_auto,f_auto)
        const optimizedPins = result.resources.map(pin => {
            const optimizedUrl = pin.secure_url.replace('/upload/', '/upload/w_400,q_auto,f_auto/');
            return { ...pin, secure_url: optimizedUrl };
        });
        
        res.json({ success: true, pins: optimizedPins });
    } catch (error) {
        console.error("Error fetching feed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Upload Image Route (FIXED: Tagging uploads properly)
app.post('/api/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image provided.' });
        }

        const tag = req.body.tag ? req.body.tag.toLowerCase() : 'untagged';
        
        // FIX: Add 'pinterest_app' tag so we own this content and don't pull random files
        const uploadStream = cloudinary.uploader.upload_stream(
            { tags: ['pinterest_app', tag] },
            (error, result) => {
                if (error) {
                    console.error("Cloudinary upload error:", error);
                    return res.status(500).json({ success: false, message: 'Upload failed.' });
                }
                res.json({ success: true, pin: result });
            }
        );
        
        uploadStream.end(req.file.buffer);
        
    } catch (error) {
        console.error("Server error during upload:", error);
        res.status(500).json({ success: false, message: 'Server error during upload.' });
    }
});

// 4. Get Entire Chat Database
app.get('/api/chat/db', async (req, res) => {
    try {
        const db = await getChatDB();
        res.json({ success: true, data: db });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch chat database.' });
    }
});

// 5. Add/Register a New User
app.post('/api/chat/user', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email required." });

        let db = await getChatDB();
        if (!db.users.includes(email)) {
            db.users.push(email);
            await saveChatDB(db);
        }
        res.json({ success: true, users: db.users });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to register user.' });
    }
});

// 6. Send a New Chat Message
app.post('/api/chat/message', async (req, res) => {
    try {
        const { sender, receiver, text, timestamp } = req.body;
        if (!sender || !receiver || !text) {
            return res.status(400).json({ success: false, message: "Missing message details." });
        }

        let db = await getChatDB();
        db.messages.push({ sender, receiver, text, timestamp: timestamp || Date.now() });
        await saveChatDB(db);

        res.json({ success: true, message: "Message sent successfully!" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to send message.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});