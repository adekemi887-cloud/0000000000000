const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const http = require('http');
const { Server } = require('socket.io');
const { Readable } = require('stream');
const crypto = require('crypto'); // Built-in Node.js module

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());

// Cloudinary Configuration
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// ADVANCED CACHING SYSTEM (PINTEREST-LIKE)
// ==========================================

// A giant memory pool that continuously gathers diverse pins in the background
const globalPinPool = new Map(); 

// Tracks individual user sessions so pagination works, but refresh creates a new feed
const sessionFeeds = new Map();  

// Caches search results to prevent repetitive API calls, allowing fast randomized reloading
const searchCache = new Map();   

// A massively expanded list to ensure incredible variety
const AESTHETIC_TOPICS = [
    "minimalist workspace", "streetwear fashion", "3d abstract blender", 
    "cozy modern interior", "cinematic photography", "neon cyberpunk",
    "vintage 90s aesthetic", "dark academia", "pastel anime room",
    "coffee shop aesthetic", "lofi chill setup", "mid century modern",
    "film camera photography", "nature landscape cinematic", "gothic architecture"
];

// Helper: Shuffle Array dynamically
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Helper: Get Client IP safely for session tracking
const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(/, /)[0] : (req.socket.remoteAddress || 'anonymous');
};

// 1. Fetch from Cloudinary
async function getCloudinaryPins() {
    try {
        const result = await cloudinary.api.resources({ type: 'upload', prefix: 'pinterest_feed/', max_results: 100, context: true });
        if (result && result.resources) {
            result.resources.forEach(res => {
                const pin = {
                    id: res.asset_id,
                    source: 'cloudinary',
                    imageUrl: res.secure_url,
                    thumbnailUrl: res.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                    title: res.context?.custom?.title || "Uploaded Pin",
                    tags: res.tags || [],
                    width: res.width || 400,
                    height: res.height || 600
                };
                globalPinPool.set(pin.id, pin);
            });
        }
    } catch (e) { console.error("Cloudinary error:", e.message); }
}

// 2. Fetch from Lexica.art
async function getLexicaPins(searchQuery = "") {
    try {
        const query = searchQuery || AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        
        return json.images.slice(0, 40).map(img => ({
            id: 'lexica_' + img.id,
            source: 'external',
            imageUrl: img.src,
            thumbnailUrl: img.srcSmall,
            title: img.prompt.split(',')[0].substring(0, 70),
            tags: ['aesthetic', 'modern', query.split(' ')[0]],
            width: img.width,
            height: img.height
        }));
    } catch (e) { return []; }
}

// 3. Fetch from Flickr
async function getFlickrPins(searchQuery = "") {
    try {
        const query = searchQuery || "aesthetic,fashion,architecture";
        const res = await fetch(`https://api.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(query)}&format=json&nojsoncallback=1`);
        const json = await res.json();
        
        return json.items.map((item, index) => {
            const thumbUrl = item.media.m.replace('_m.jpg', '_z.jpg'); 
            const largeUrl = item.media.m.replace('_m.jpg', '_b.jpg');
            
            let cleanTitle = item.title ? item.title.trim() : "Inspiration";
            if (cleanTitle.toLowerCase().includes('dsc') || cleanTitle.toLowerCase().includes('img')) {
                cleanTitle = "Aesthetic Photography";
            }
            
            return {
                id: 'flickr_' + Date.now() + '_' + index,
                source: 'external',
                imageUrl: largeUrl,
                thumbnailUrl: thumbUrl,
                title: cleanTitle.substring(0, 60),
                tags: item.tags ? item.tags.split(' ').slice(0, 3) : [],
                width: 400, 
                height: Math.floor(Math.random() * (350 - 200 + 1) + 200) 
            };
        });
    } catch (e) { return []; }
}

// ==========================================
// BACKGROUND CACHE BUILDER
// ==========================================
async function buildGlobalFeed() {
    console.log("Expanding global cache pool with diverse modern content...");
    await getCloudinaryPins(); // Always pull in latest local uploads
    
    // Pick 2 random unique topics on every refresh interval to gather vast variety
    const randomTopic1 = AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
    let randomTopic2 = AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
    if (randomTopic1 === randomTopic2) randomTopic2 = "architecture interior";

    // Fetch in parallel
    const [lexica1, lexica2, flickr1, flickr2] = await Promise.all([
        getLexicaPins(randomTopic1),
        getLexicaPins(randomTopic2),
        getFlickrPins(randomTopic1),
        getFlickrPins(randomTopic2)
    ]);
    
    // Push new content into the global Map (Automatically deduplicates by ID)
    const combinedExternal = [...lexica1, ...lexica2, ...flickr1, ...flickr2];
    combinedExternal.forEach(pin => globalPinPool.set(pin.id, pin));

    // Memory protection: Keep pool large (max 2500) but don't delete Cloudinary items
    if (globalPinPool.size > 2500) {
        let deletedCount = 0;
        const targetDelete = globalPinPool.size - 2500;
        for (const [key, pin] of globalPinPool.entries()) {
            if (pin.source === 'external') {
                globalPinPool.delete(key);
                deletedCount++;
            }
            if (deletedCount >= targetDelete) break;
        }
    }
    
    console.log(`Global cache pool actively holding ${globalPinPool.size} unique pins.`);
}

// Initial load, then refresh every 10 minutes
buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); 

// Memory Cleanup: Delete inactive user sessions & search caches older than 1 hour
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessionFeeds.entries()) {
        if (now - session.timestamp > 3600000) sessionFeeds.delete(key);
    }
    for (const [key, cache] of searchCache.entries()) {
        if (now - cache.timestamp > 3600000) searchCache.delete(key);
    }
}, 15 * 60 * 1000);

// ==========================================
// API ROUTES
// ==========================================

// FAST FEED PAGINATION (Dynamic per-user Session)
app.get('/api/pins', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    
    // Track user uniquely so infinite scrolling works seamlessly
    const sessionId = req.query.sessionId || getClientIp(req);

    // CRUCIAL: If user requests page 1 (like hitting refresh), or has no session...
    // We generate a brand NEW shuffled feed for them. This solves the "repetitive content" issue.
    if (page === 1 || !sessionFeeds.has(sessionId)) {
        const allPins = Array.from(globalPinPool.values());
        const newlyShuffledFeed = shuffleArray(allPins); // Every refresh is uniquely arranged
        sessionFeeds.set(sessionId, { feed: newlyShuffledFeed, timestamp: Date.now() });
    }

    const sessionData = sessionFeeds.get(sessionId);
    sessionData.timestamp = Date.now(); // Update last active

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedPins = sessionData.feed.slice(startIndex, endIndex);
    
    res.json({
        data: paginatedPins,
        currentPage: page,
        hasMore: endIndex < sessionData.feed.length,
        sessionId: sessionId // Frontend can track this, or ignore it since IP fallback handles it
    });
});

// TRUE CACHED GLOBAL SEARCH (Actively randomizes results upon search refresh)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.json({ data: [], hasMore: false });
    }

    const normalizedQuery = query.toLowerCase().trim();

    try {
        // If this query hasn't been searched recently, fetch & cache it
        if (!searchCache.has(normalizedQuery)) {
            // 1. Search local cached uploads
            const localMatches = Array.from(globalPinPool.values()).filter(pin => 
                (pin.title && pin.title.toLowerCase().includes(normalizedQuery)) ||
                (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(normalizedQuery)))
            );

            // 2. Fetch LIVE from APIs
            const [lexicaMatches, flickrMatches] = await Promise.all([
                getLexicaPins(normalizedQuery),
                getFlickrPins(normalizedQuery)
            ]);

            // Deduplicate items securely into a new map
            const searchMerge = new Map();
            [...localMatches, ...lexicaMatches, ...flickrMatches].forEach(pin => {
                searchMerge.set(pin.id, pin);
            });

            // Cache it
            searchCache.set(normalizedQuery, {
                pins: Array.from(searchMerge.values()),
                timestamp: Date.now()
            });
        }

        const cacheData = searchCache.get(normalizedQuery);
        cacheData.timestamp = Date.now(); 

        // CRUCIAL: Shuffle the cached results!
        // If a user re-searches the same term or refreshes, they instantly get a new visual layout 
        // without waiting for slow API requests again.
        const shuffledSearchResults = shuffleArray(cacheData.pins);

        res.json({ data: shuffledSearchResults.slice(0, 40), hasMore: false });
    } catch (error) {
        console.error("Search API Error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

// CLOUDINARY UPLOAD
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    const title = req.body.title || 'New Pin';
    
    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "pinterest_feed", context: `title=${title}` },
        (error, result) => {
            if (error) return res.status(500).json({ error: "Upload failed" });

            const newPin = {
                id: result.asset_id,
                source: 'cloudinary',
                imageUrl: result.secure_url,
                thumbnailUrl: result.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: title,
                width: result.width || 400,
                height: result.height || 600
            };

            // 1. Inject to global pool
            globalPinPool.set(newPin.id, newPin);
            
            // 2. Inject at the VERY TOP of all active user sessions instantly
            for (const session of sessionFeeds.values()) {
                session.feed.unshift(newPin);
            }
            
            io.emit('new_pin', newPin);
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Ultra-Optimized Pinterest Backend with Session Caching & Smart Randomization Running!"));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));