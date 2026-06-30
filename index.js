const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const http = require('http');
const { Server } = require('socket.io');
const { Readable } = require('stream');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Hardcoded Cloudinary Configuration
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

// Configure Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Array to hold our personal Cloudinary uploads
let feedData = [];

// Fetch existing pins from Cloudinary on Server Startup
async function loadExistingPins() {
    try {
        console.log("Fetching existing images from Cloudinary...");
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: 'pinterest_feed/',
            max_results: 100,
            tags: true,
            context: true
        });
        
        if (result && result.resources) {
            feedData = result.resources.map(res => ({
                id: res.asset_id,
                imageUrl: res.secure_url,
                title: res.context?.custom?.title || "Untitled",
                tags: res.tags || [],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: res.created_at
            }));
            
            feedData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            console.log(`Successfully loaded ${feedData.length} pins from Cloudinary.`);
        }
    } catch (error) {
        console.error("Notice: Could not load initial pins.", error.message);
    }
}
loadExistingPins();


// ==========================================
// EXTERNAL API FETCHERS
// ==========================================

const FETCH_OPTS = { headers: { 'User-Agent': 'NodeJS/PinterestClone/1.0' } };

async function getRedditPins() {
    try {
        // Fetch from multiple art/wallpaper subreddits
        const res = await fetch('https://www.reddit.com/r/wallpapers+EarthPorn+DesignPorn/hot.json?limit=15', FETCH_OPTS);
        const json = await res.json();
        return json.data.children
            .filter(c => c.data.url && (c.data.url.endsWith('.jpg') || c.data.url.endsWith('.png')))
            .map(c => ({
                id: 'reddit_' + c.data.id,
                imageUrl: c.data.url,
                title: c.data.title || "Reddit Pin",
                tags: ['reddit', 'wallpaper'],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: new Date(c.data.created_utc * 1000).toISOString()
            }));
    } catch (e) {
        console.error("Reddit fetch error:", e.message);
        return [];
    }
}

async function getWallhavenPins() {
    try {
        // Fetch random wallpapers
        const res = await fetch('https://wallhaven.cc/api/v1/search?sorting=random&purity=100&limit=15', FETCH_OPTS);
        const json = await res.json();
        return json.data.map(item => ({
            id: 'wallhaven_' + item.id,
            imageUrl: item.path,
            title: "HD Wallpaper",
            tags: ['wallhaven', 'design'],
            height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
            createdAt: new Date().toISOString()
        }));
    } catch (e) {
        console.error("Wallhaven fetch error:", e.message);
        return [];
    }
}

async function getDanbooruPins() {
    try {
        // Fetch safe anime art
        const res = await fetch('https://danbooru.donmai.us/posts.json?limit=15&tags=rating:safe', FETCH_OPTS);
        const json = await res.json();
        return json
            .filter(item => item.large_file_url || item.file_url)
            .map(item => ({
                id: 'danbooru_' + item.id,
                imageUrl: item.large_file_url || item.file_url,
                title: "Anime Art",
                tags: ['danbooru', 'anime', 'aesthetic'],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: item.created_at
            }));
    } catch (e) {
        console.error("Danbooru fetch error:", e.message);
        return [];
    }
}

// Utility function to randomize/shuffle an array
function shuffleArray(array) {
    let mixed = [...array];
    for (let i = mixed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    return mixed;
}

// ==========================================
// API ROUTES
// ==========================================

// GET /api/pins - Mixes Cloudinary + Reddit + Wallhaven + Danbooru
app.get('/api/pins', async (req, res) => {
    try {
        // Fetch from all external APIs simultaneously to save time
        const [redditPins, wallhavenPins, danbooruPins] = await Promise.all([
            getRedditPins(),
            getWallhavenPins(),
            getDanbooruPins()
        ]);
        
        // Combine your Cloudinary uploads with the external fetched data
        const combinedFeed = [
            ...feedData,
            ...redditPins,
            ...wallhavenPins,
            ...danbooruPins
        ];
        
        // Shuffle the results so they are completely mixed up!
        const shuffledFeed = shuffleArray(combinedFeed);
        
        res.json(shuffledFeed);
    } catch (error) {
        console.error("Error generating combined feed:", error);
        // If external APIs fail, just return our Cloudinary pins randomly mixed
        res.json(shuffleArray(feedData));
    }
});


// POST /api/upload - Handle new image uploads to Cloudinary
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
    }
    
    const title = req.body.title || 'New Pin';
    const tags = req.body.tags ? req.body.tags.split(',').map(tag => tag.trim()) : [];
    
    const uploadStream = cloudinary.uploader.upload_stream(
        {
            folder: "pinterest_feed",
            tags: tags,
            context: `title=${title}`
        },
        (error, result) => {
            if (error) {
                console.error("Cloudinary Upload Error:", error);
                return res.status(500).json({ error: "Upload failed" });
            }
            
            const newPin = {
                id: result.asset_id,
                imageUrl: result.secure_url,
                title: title,
                tags: tags,
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: result.created_at
            };
            
            // Add the new pin to our personal feedData
            feedData.unshift(newPin);
            
            // Broadcast new pin to frontend instantly
            io.emit('new_pin', newPin);
            
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => {
    res.send("Pinterest Backend Server is running successfully with Reddit, Danbooru, and Wallhaven integrated!");
});

// Prevent server crash on unexpected errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// ==========================================
// START THE SERVER
// ==========================================
const PORT = process.env.PORT || 5000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
}).on('error', (err) => {
    console.error('Failed to start server:', err);
});