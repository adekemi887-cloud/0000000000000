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
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// Cloudinary Configuration
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// MEMORY CACHES (FOR LIGHTNING FAST LOADING)
// ==========================================
let cloudinaryFeed = [];
let externalPinsCache = [];

// 1. Load Cloudinary Uploads
async function loadCloudinaryPins() {
    try {
        console.log("Fetching uploads from Cloudinary...");
        const result = await cloudinary.api.resources({
            type: 'upload', prefix: 'pinterest_feed/', max_results: 100, tags: true, context: true
        });

        if (result && result.resources) {
            cloudinaryFeed = result.resources.map(res => ({
                id: res.asset_id,
                imageUrl: res.secure_url,
                title: res.context?.custom?.title || "Uploaded Pin",
                tags: res.tags || [],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: res.created_at
            }));
            console.log(`Loaded ${cloudinaryFeed.length} pins from Cloudinary.`);
        }
    } catch (error) {
        console.error("Cloudinary fetch error (Normal if empty):", error.message);
    }
}
loadCloudinaryPins();

// ==========================================
// EXTERNAL API FETCHERS
// ==========================================
// Spoofing User-Agent is required so Reddit & Wallhaven don't block the server
const FETCH_HEADERS = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' 
};

async function getRedditPins() {
    try {
        const res = await fetch('https://www.reddit.com/r/wallpapers+EarthPorn+DesignPorn+Amoledbackgrounds/hot.json?limit=40', { headers: FETCH_HEADERS });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        const json = await res.json();
        
        return json.data.children
            .filter(c => c.data && c.data.url_overridden_by_dest && c.data.post_hint === 'image')
            .map(c => ({
                id: 'reddit_' + c.data.id,
                imageUrl: c.data.url_overridden_by_dest,
                title: c.data.title.substring(0, 50),
                tags: ['reddit', 'wallpaper', c.data.subreddit.toLowerCase()],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: new Date(c.data.created_utc * 1000).toISOString()
            }));
    } catch (e) { console.error("Reddit error:", e.message); return []; }
}

async function getWallhavenPins(searchQuery = "") {
    try {
        const url = searchQuery 
            ? `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(searchQuery)}&sorting=relevance&purity=100&limit=30`
            : `https://wallhaven.cc/api/v1/search?sorting=random&purity=100&limit=30`;
            
        const res = await fetch(url, { headers: FETCH_HEADERS });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        const json = await res.json();
        
        return json.data.map(item => ({
            id: 'wallhaven_' + item.id,
            imageUrl: item.path,
            title: searchQuery ? `Wallhaven ${searchQuery}` : "HD Wallpaper",
            tags: ['wallhaven', 'design', 'aesthetic', searchQuery].filter(Boolean),
            height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
            createdAt: new Date().toISOString()
        }));
    } catch (e) { console.error("Wallhaven error:", e.message); return []; }
}

async function getDanbooruPins(searchQuery = "") {
    try {
        // Danbooru handles one-word tags best
        const query = searchQuery ? encodeURIComponent(searchQuery.split(' ')[0] + ' rating:safe') : 'rating:safe';
        const res = await fetch(`https://danbooru.donmai.us/posts.json?limit=30&tags=${query}`, { headers: FETCH_HEADERS });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        const json = await res.json();
        
        return json
            .filter(item => item.large_file_url || item.file_url)
            .map(item => ({
                id: 'danbooru_' + item.id,
                imageUrl: item.large_file_url || item.file_url,
                title: "Anime Art",
                tags: ['danbooru', 'anime', searchQuery].filter(Boolean),
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: item.created_at
            }));
    } catch (e) { console.error("Danbooru error:", e.message); return []; }
}

function shuffleArray(array) {
    let mixed = [...array];
    for (let i = mixed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    return mixed;
}

// 2. Background Polling for fast loading
async function refreshExternalPins() {
    console.log("Refreshing external pins cache in the background...");
    const [reddit, wallhaven, danbooru] = await Promise.all([
        getRedditPins(), getWallhavenPins(), getDanbooruPins()
    ]);
    
    const newCache = [...reddit, ...wallhaven, ...danbooru];
    if (newCache.length > 0) {
        externalPinsCache = newCache;
        console.log(`Cache updated. Holding ${externalPinsCache.length} external mixed pins ready to serve.`);
    }
}
// Fetch immediately, then refresh every 10 minutes automatically
refreshExternalPins();
setInterval(refreshExternalPins, 10 * 60 * 1000);

// ==========================================
// API ROUTES
// ==========================================

// FAST FEED: Instantly returns the cached external pins mixed with your Cloudinary uploads
app.get('/api/pins', (req, res) => {
    const combinedFeed = [...cloudinaryFeed, ...externalPinsCache];
    res.json(shuffleArray(combinedFeed));
});

// LIVE SEARCH: Actively searches Wallhaven & Danbooru servers + Local Cloudinary matches
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    
    // If search is empty, just return standard feed
    if (!query) {
        return res.json(shuffleArray([...cloudinaryFeed, ...externalPinsCache]));
    }

    try {
        // Search External Servers live
        const [wallhaven, danbooru] = await Promise.all([
            getWallhavenPins(query), getDanbooruPins(query)
        ]);

        // Search your personal Cloudinary pins locally
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );

        // Mix and return
        const searchResults = [...cloudinaryMatches, ...wallhaven, ...danbooru];
        res.json(shuffleArray(searchResults));
    } catch (error) {
        console.error("Search API Error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

// POST UPLOAD: Handles user uploads to Cloudinary
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });

    const title = req.body.title || 'New Pin';
    const tags = req.body.tags ? req.body.tags.split(',').map(tag => tag.trim()) : [];

    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "pinterest_feed", tags: tags, context: `title=${title}` },
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

            // Add to the top of our local cloudinary feed
            cloudinaryFeed.unshift(newPin);
            
            // Send to everyone connected instantly
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
    res.send("Backend Server is Running! Optimized Caching, External Fetching, and Live Search are Active.");
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
}).on('error', (err) => {
    console.error('Failed to start server:', err);
});