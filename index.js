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

// ==========================================
// SMART CACHE & PERSONALIZATION SYSTEM
// ==========================================
let cloudinaryFeed = [];
const keywordCache = {}; // { "fashion": [...pins], "bag": [...pins] }
const userProfiles = {}; // { "user_123": { seen: Set(), interests: {} } }
const DEFAULT_TOPICS = ["minimalist aesthetic", "streetwear fashion", "interior design", "cinematic photography"];

// --- 1. Cloudinary Fetcher (RESTORED & FIXED) ---
async function getCloudinaryPins() {
    try {
        const result = await cloudinary.api.resources({ type: 'upload', prefix: 'pinterest_feed/', max_results: 100, context: true });
        if (result && result.resources) {
            cloudinaryFeed = result.resources.map(res => ({
                id: res.asset_id,
                imageUrl: res.secure_url,
                thumbnailUrl: res.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: res.context?.custom?.title || "Uploaded Pin",
                tags: res.tags || [],
                width: res.width || 400,
                height: res.height || 600
            }));
            console.log(`[Cloudinary] Loaded ${cloudinaryFeed.length} local pins.`);
        }
    } catch (e) { console.error("Cloudinary error:", e.message); }
}

// Initialize on startup & refresh every 10 mins
getCloudinaryPins();
setInterval(getCloudinaryPins, 10 * 60 * 1000);


// --- 2. External API Fetchers ---
async function getLexicaPins(query) {
    try {
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        return (json.images || []).slice(0, 40).map(img => ({
            id: 'lex_v2_' + img.id,
            imageUrl: img.src,
            thumbnailUrl: img.srcSmall, 
            title: img.prompt.split(',')[0].substring(0, 70), 
            tags: ['aesthetic', query.split(' ')[0]],
            width: img.width,
            height: img.height
        }));
    } catch (e) { return []; }
}

async function getFlickrPins(query) {
    try {
        const res = await fetch(`https://api.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(query)}&format=json&nojsoncallback=1`);
        const json = await res.json();
        return (json.items || []).map((item, index) => {
            let cleanTitle = item.title ? item.title.trim() : "Inspiration";
            if (cleanTitle.toLowerCase().includes('dsc') || cleanTitle.toLowerCase().includes('img')) cleanTitle = "Aesthetic";
            return {
                id: 'flk_v2_' + Date.now() + '_' + index,
                imageUrl: item.media.m.replace('_m.jpg', '_b.jpg'),
                thumbnailUrl: item.media.m.replace('_m.jpg', '_z.jpg'),
                title: cleanTitle.substring(0, 60),
                tags: item.tags ? item.tags.split(' ').slice(0, 3) : [],
                width: 400, 
                height: Math.floor(Math.random() * (350 - 200 + 1) + 200) 
            };
        });
    } catch (e) { return []; }
}

// Ensures we have enough pins for a specific keyword in our memory pool
async function ensureKeywordCache(keyword) {
    if (!keywordCache[keyword]) keywordCache[keyword] = [];
    if (keywordCache[keyword].length < 40) {
        console.log(`[API Fetch] Building cache for: "${keyword}"`);
        const [lexica, flickr] = await Promise.all([getLexicaPins(keyword), getFlickrPins(keyword)]);
        const newPins = [...lexica, ...flickr].sort(() => 0.5 - Math.random());
        
        // Push unique pins to cache
        const existingIds = new Set(keywordCache[keyword].map(p => p.id));
        newPins.forEach(p => { if (!existingIds.has(p.id)) keywordCache[keyword].push(p); });
    }
}


// ==========================================
// API ROUTES
// ==========================================

// 1. SMART PERSONALIZED FEED (WITH GUARANTEED CLOUDINARY INCLUSION)
app.get('/api/pins', async (req, res) => {
    const userId = req.query.userId || 'anonymous';
    const limit = parseInt(req.query.limit) || 20; 
    let incomingInterests = req.query.interests ? req.query.interests.split(',') : [];

    if (!userProfiles[userId]) {
        userProfiles[userId] = { seen: new Set(), interests: {} };
    }
    const profile = userProfiles[userId];

    // Determine target keywords
    let targetKeywords = incomingInterests.length > 0 ? incomingInterests : Object.keys(profile.interests).sort((a, b) => profile.interests[b] - profile.interests[a]).slice(0, 3);
    if (targetKeywords.length === 0) targetKeywords = [DEFAULT_TOPICS[Math.floor(Math.random() * DEFAULT_TOPICS.length)]];

    // Ensure external caches are built
    await Promise.all(targetKeywords.map(kw => ensureKeywordCache(kw)));

    // --- SEPARATE POOLS LOGIC ---
    
    // Pool 1: External Content
    let externalPins = [];
    targetKeywords.forEach(kw => { if (keywordCache[kw]) externalPins.push(...keywordCache[kw]); });
    
    // ONLY filter external content by what the user has seen
    externalPins = externalPins.filter(pin => !profile.seen.has(pin.id));

    // Ratio Enforcement: Try to make ~35% of the feed Cloudinary (user uploads)
    const CLOUD_RATIO = 0.35;
    let cloudLimit = Math.floor(limit * CLOUD_RATIO);
    let extLimit = limit - cloudLimit;

    // Pick Cloudinary Pins (Never filtered by "seen", randomly shuffled so it stays fresh)
    let cloudSelection = [...cloudinaryFeed].sort(() => 0.5 - Math.random()).slice(0, cloudLimit);

    // If Cloudinary lacks enough pins, give the extra slots to external APIs
    if (cloudSelection.length < cloudLimit) {
        extLimit += (cloudLimit - cloudSelection.length);
    }

    // Fallback if user consumed ALL external content for these keywords
    if (externalPins.length < extLimit) {
        console.log(`[Cache Reset] User ${userId} consumed all external content. Clearing history.`);
        profile.seen.clear();
        externalPins = [];
        targetKeywords.forEach(kw => { if (keywordCache[kw]) externalPins.push(...keywordCache[kw]); });
    }

    let extSelection = externalPins.sort(() => 0.5 - Math.random()).slice(0, extLimit);

    // Track newly seen EXTERNAL pins
    extSelection.forEach(pin => profile.seen.add(pin.id));

    // Mix them together naturally
    const finalFeed = [...cloudSelection, ...extSelection].sort(() => 0.5 - Math.random());

    // Debugging Outputs
    console.log(`[Feed Generation] User: ${userId}`);
    console.log(`-> Cloudinary DB: ${cloudinaryFeed.length} | Serving: ${cloudSelection.length}`);
    console.log(`-> Keyword Pools: ${Object.keys(keywordCache).join(', ')} | Serving: ${extSelection.length}`);

    res.json({
        data: finalFeed,
        hasMore: true
    });
});

// 2. LIVE SEARCH (DETERMINISTIC)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: [], hasMore: false });

    try {
        await ensureKeywordCache(query); 
        let searchResults = [...keywordCache[query]];

        // Prepend local uploads matching the query
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );
        
        // Remove duplicates if Cloudinary matches existed in external somehow
        const cloudIds = new Set(cloudinaryMatches.map(p => p.id));
        searchResults = searchResults.filter(p => !cloudIds.has(p.id));

        searchResults = [...cloudinaryMatches, ...searchResults];

        res.json({ data: searchResults, hasMore: searchResults.length > 0 });
    } catch (error) {
        res.status(500).json({ error: "Search failed" });
    }
});

// 3. UPLOAD HANDLING
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    const title = req.body.title || 'New Pin';
    
    const uploadStream = cloudinary.uploader.upload_stream(
        { folder: "pinterest_feed", context: `title=${title}` },
        (error, result) => {
            if (error) return res.status(500).json({ error: "Upload failed" });
            const newPin = {
                id: result.asset_id, imageUrl: result.secure_url,
                thumbnailUrl: result.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: title, width: result.width || 400, height: result.height || 600, tags: []
            };
            
            // Add instantly to global memory
            cloudinaryFeed.unshift(newPin);
            io.emit('new_pin', newPin);
            
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Personalized Smart Backend Active!"));
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));