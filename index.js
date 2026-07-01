const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const http = require('http');
const { Server } = require('socket.io');
const { Readable } = require('stream');

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

// Memory Data stores
const globalPinPool = new Map(); // Generic fallback pool
const sessionFeeds = new Map();  // User-specific personalized feeds
const searchCache = new Map();   // Saved search queries

const AESTHETIC_TOPICS = [
    "minimalist workspace", "streetwear fashion", "3d abstract blender", 
    "cozy modern interior", "cinematic photography", "neon cyberpunk",
    "dark academia", "coffee shop aesthetic", "lofi chill setup"
];

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(/, /)[0] : (req.socket.remoteAddress || 'anonymous');
};

async function getCloudinaryPins() {
    try {
        const result = await cloudinary.api.resources({ type: 'upload', prefix: 'pinterest_feed/', max_results: 100, context: true });
        if (result && result.resources) {
            result.resources.forEach(res => {
                const pin = {
                    id: res.asset_id, source: 'cloudinary', imageUrl: res.secure_url,
                    thumbnailUrl: res.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                    title: res.context?.custom?.title || "Uploaded Pin",
                    tags: res.tags || [], width: res.width || 400, height: res.height || 600
                };
                globalPinPool.set(pin.id, pin);
            });
        }
    } catch (e) { console.error("Cloudinary error:", e.message); }
}

async function getLexicaPins(searchQuery = "") {
    try {
        const query = searchQuery || AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
        // Fast Timeout implementation to prevent blocking
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000); 
        
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const json = await res.json();
        
        return json.images.slice(0, 40).map(img => ({
            id: 'lexica_' + img.id, source: 'external', imageUrl: img.src, thumbnailUrl: img.srcSmall,
            title: img.prompt.split(',')[0].substring(0, 70), tags: ['aesthetic', query], width: img.width, height: img.height
        }));
    } catch (e) { return []; }
}

async function getFlickrPins(searchQuery = "") {
    try {
        const query = searchQuery || "aesthetic";
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const res = await fetch(`https://api.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(query)}&format=json&nojsoncallback=1`, { signal: controller.signal });
        clearTimeout(timeoutId);
        const json = await res.json();
        
        return json.items.map((item, index) => {
            const thumbUrl = item.media.m.replace('_m.jpg', '_z.jpg'); 
            const largeUrl = item.media.m.replace('_m.jpg', '_b.jpg');
            let cleanTitle = item.title ? item.title.trim() : "Inspiration";
            if (cleanTitle.toLowerCase().includes('dsc') || cleanTitle.toLowerCase().includes('img')) cleanTitle = "Aesthetic Photography";
            
            return {
                id: 'flickr_' + Date.now() + '_' + index, source: 'external', imageUrl: largeUrl, thumbnailUrl: thumbUrl,
                title: cleanTitle.substring(0, 60), tags: item.tags ? item.tags.split(' ').slice(0, 3) : [],
                width: 400, height: Math.floor(Math.random() * (350 - 200 + 1) + 200) 
            };
        });
    } catch (e) { return []; }
}

// Background builder ensures we always have a generic fallback pool available instantly.
async function buildGlobalFeed() {
    await getCloudinaryPins(); 
    const randomTopic1 = AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
    const randomTopic2 = AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
    
    const [lexica1, lexica2, flickr1, flickr2] = await Promise.all([
        getLexicaPins(randomTopic1), getLexicaPins(randomTopic2), getFlickrPins(randomTopic1), getFlickrPins(randomTopic2)
    ]);
    
    [...lexica1, ...lexica2, ...flickr1, ...flickr2].forEach(pin => globalPinPool.set(pin.id, pin));
    if (globalPinPool.size > 2000) {
        let deletedCount = 0; const targetDelete = globalPinPool.size - 2000;
        for (const [key, pin] of globalPinPool.entries()) {
            if (pin.source === 'external') { globalPinPool.delete(key); deletedCount++; }
            if (deletedCount >= targetDelete) break;
        }
    }
}
buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); 

// Clear dead sessions
setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessionFeeds.entries()) { if (now - session.timestamp > 3600000) sessionFeeds.delete(key); }
    for (const [key, cache] of searchCache.entries()) { if (now - cache.timestamp > 3600000) searchCache.delete(key); }
}, 15 * 60 * 1000);

// ==========================================
// API ROUTES
// ==========================================

// PERSONALIZED FEED GENERATION
app.get('/api/pins', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    const sessionId = req.query.sessionId || getClientIp(req);
    const userInterests = req.query.interests || ""; // Received from frontend local storage!

    // Create a brand new session/feed if they request page 1 (pull-to-refresh) OR they don't have a session.
    if (page === 1 || !sessionFeeds.has(sessionId)) {
        let dynamicFeed = [];

        // If the user has a registered Interest Profile, fetch tailored content live!
        if (userInterests) {
            const keywords = userInterests.split(',').filter(k => k.trim());
            // Fetch concurrently to save time
            const tailoredResults = await Promise.all(
                keywords.map(async kw => {
                    const lex = await getLexicaPins(kw);
                    const fli = await getFlickrPins(kw);
                    return [...lex, ...fli];
                })
            );
            dynamicFeed = tailoredResults.flat();
            
            // Backfill with the global cache if APIs didn't return enough for a full infinite scroll loop
            if (dynamicFeed.length < 50) {
                const fallback = shuffleArray(Array.from(globalPinPool.values())).slice(0, 150);
                dynamicFeed = [...dynamicFeed, ...fallback];
            }
        } else {
            // User is entirely new (no interests). Give them the massive shuffled generic pool.
            dynamicFeed = shuffleArray(Array.from(globalPinPool.values()));
        }

        // Deduplicate
        const uniqueFeedMap = new Map();
        dynamicFeed.forEach(p => uniqueFeedMap.set(p.id, p));
        
        sessionFeeds.set(sessionId, { 
            feed: shuffleArray(Array.from(uniqueFeedMap.values())), 
            timestamp: Date.now() 
        });
    }

    const sessionData = sessionFeeds.get(sessionId);
    sessionData.timestamp = Date.now(); 

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedPins = sessionData.feed.slice(startIndex, endIndex);
    
    res.json({
        data: paginatedPins,
        currentPage: page,
        hasMore: endIndex < sessionData.feed.length
    });
});

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: [], hasMore: false });

    const normalizedQuery = query.toLowerCase().trim();
    try {
        if (!searchCache.has(normalizedQuery)) {
            const localMatches = Array.from(globalPinPool.values()).filter(pin => 
                (pin.title && pin.title.toLowerCase().includes(normalizedQuery)) ||
                (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(normalizedQuery)))
            );
            const [lexicaMatches, flickrMatches] = await Promise.all([ getLexicaPins(normalizedQuery), getFlickrPins(normalizedQuery) ]);
            
            const searchMerge = new Map();
            [...localMatches, ...lexicaMatches, ...flickrMatches].forEach(pin => searchMerge.set(pin.id, pin));

            searchCache.set(normalizedQuery, { pins: Array.from(searchMerge.values()), timestamp: Date.now() });
        }

        const cacheData = searchCache.get(normalizedQuery);
        cacheData.timestamp = Date.now(); 

        const shuffledSearchResults = shuffleArray(cacheData.pins);
        res.json({ data: shuffledSearchResults.slice(0, 40), hasMore: false });
    } catch (error) { res.status(500).json({ error: "Search failed" }); }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    const title = req.body.title || 'New Pin';
    
    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "pinterest_feed", context: `title=${title}` },
        (error, result) => {
            if (error) return res.status(500).json({ error: "Upload failed" });
            const newPin = {
                id: result.asset_id, source: 'cloudinary', imageUrl: result.secure_url,
                thumbnailUrl: result.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: title, width: result.width || 400, height: result.height || 600
            };

            globalPinPool.set(newPin.id, newPin);
            for (const session of sessionFeeds.values()) { session.feed.unshift(newPin); }
            
            io.emit('new_pin', newPin);
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Dynamic Personalized User Engine Running!"));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));