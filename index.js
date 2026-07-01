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
const keywordCache = {}; // Now includes TTL: { "bag": { data: [], timestamp: 12345 } }
const userProfiles = {}; // { "user_123": { seen: Set(), interests: { bag: 10 } } }
const DEFAULT_TOPICS = ["minimalist aesthetic", "streetwear fashion", "interior design", "cinematic photography"];
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// --- 1. Cloudinary Fetcher ---
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

getCloudinaryPins();
setInterval(getCloudinaryPins, 10 * 60 * 1000);

// --- 2. External API Fetchers ---
async function getLexicaPins(query) {
    try {
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        return (json.images || []).slice(0, 40).map(img => ({
            id: 'lex_v2_' + img.id, imageUrl: img.src, thumbnailUrl: img.srcSmall, 
            title: img.prompt.split(',')[0].substring(0, 70), tags: ['aesthetic', query.split(' ')[0]],
            width: img.width, height: img.height
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
                title: cleanTitle.substring(0, 60), tags: item.tags ? item.tags.split(' ').slice(0, 3) : [],
                width: 400, height: Math.floor(Math.random() * (350 - 200 + 1) + 200) 
            };
        });
    } catch (e) { return []; }
}

// Ensures we have fresh pins with TTL checking
async function ensureKeywordCache(keyword) {
    const now = Date.now();
    
    if (!keywordCache[keyword] || (now - keywordCache[keyword].timestamp > CACHE_TTL)) {
        console.log(`[API Fetch] Building/Refreshing cache for: "${keyword}"`);
        const [lexica, flickr] = await Promise.all([getLexicaPins(keyword), getFlickrPins(keyword)]);
        const newPins = [...lexica, ...flickr].sort(() => 0.5 - Math.random());
        
        // Remove duplicates and store with new timestamp
        const uniquePins = [];
        const existingIds = new Set();
        newPins.forEach(p => { 
            if (!existingIds.has(p.id)) { existingIds.add(p.id); uniquePins.push(p); }
        });
        
        keywordCache[keyword] = { data: uniquePins, timestamp: now };
    }
}

// ==========================================
// API ROUTES
// ==========================================

// 1. INTEREST TRACKER (NEW! Makes Personalization actually work)
app.post('/api/track-interest', (req, res) => {
    const { userId, keywords, points } = req.body;
    if (!userId || !keywords || keywords.length === 0) return res.status(400).json({ error: "Invalid data" });

    if (!userProfiles[userId]) {
        userProfiles[userId] = { seen: new Set(), interests: {} };
    }

    const profile = userProfiles[userId];
    keywords.forEach(kw => {
        profile.interests[kw] = (profile.interests[kw] || 0) + (points || 1);
    });

    console.log(`[Interest Updated] User ${userId}:`, profile.interests);
    res.json({ success: true });
});

// 2. SMART PAGINATED FEED
app.get('/api/pins', async (req, res) => {
    const userId = req.query.userId || 'anonymous';
    const limit = parseInt(req.query.limit) || 20; 
    const page = parseInt(req.query.page) || 1; // Used for session tracking
    let incomingInterests = req.query.interests ? req.query.interests.split(',') : [];

    if (!userProfiles[userId]) {
        userProfiles[userId] = { seen: new Set(), interests: {} };
    }
    const profile = userProfiles[userId];

    // ✅ FIX 3: Reset user's 'seen' history on Page 1 (Hard Refresh). 
    // This solves duplicates and ensures infinite scroll acts deterministically.
    if (page === 1) {
        profile.seen.clear();
        console.log(`[New Session] Cleared seen history for ${userId}`);
    }

    // Determine target keywords
    let targetKeywords = incomingInterests.length > 0 ? incomingInterests : Object.keys(profile.interests).sort((a, b) => profile.interests[b] - profile.interests[a]).slice(0, 3);
    if (targetKeywords.length === 0) targetKeywords = [DEFAULT_TOPICS[Math.floor(Math.random() * DEFAULT_TOPICS.length)]];

    // Ensure external caches are built
    await Promise.all(targetKeywords.map(kw => ensureKeywordCache(kw)));

    let externalPins = [];
    targetKeywords.forEach(kw => { if (keywordCache[kw]) externalPins.push(...keywordCache[kw].data); });
    
    // Filter BOTH by what the user has seen in THIS infinite scroll session
    let freshCloud = cloudinaryFeed.filter(pin => !profile.seen.has(pin.id));
    let freshExt = externalPins.filter(pin => !profile.seen.has(pin.id));

    // Fallback: If exhausted, reset specifically for infinite scroll failsafe
    if (freshCloud.length + freshExt.length < limit) {
        profile.seen.clear();
        freshCloud = [...cloudinaryFeed];
        freshExt = [...externalPins];
    }

    // Ratio Enforcement (35% Local, 65% External)
    const CLOUD_RATIO = 0.35;
    let cloudLimit = Math.floor(limit * CLOUD_RATIO);
    let extLimit = limit - cloudLimit;

    let cloudSelection = freshCloud.sort(() => 0.5 - Math.random()).slice(0, cloudLimit);
    if (cloudSelection.length < cloudLimit) extLimit += (cloudLimit - cloudSelection.length);
    let extSelection = freshExt.sort(() => 0.5 - Math.random()).slice(0, extLimit);

    const finalFeed = [...cloudSelection, ...extSelection].sort(() => 0.5 - Math.random());
    
    // Track newly seen pins so Page 2, 3, etc., never duplicate!
    finalFeed.forEach(pin => profile.seen.add(pin.id));

    res.json({ data: finalFeed, hasMore: true });
});

// 3. LIVE SEARCH (Improved Cloudinary Matching)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: [], hasMore: false });

    try {
        await ensureKeywordCache(query); 
        let searchResults = [...keywordCache[query].data];

        // ✅ FIX 4: Better Search Matching (Tokenized / Lenient)
        const searchTerms = query.toLowerCase().split(/\s+/);
        const cloudinaryMatches = cloudinaryFeed.filter(pin => {
            const textToSearch = ((pin.title || '') + ' ' + (pin.tags || []).join(' ')).toLowerCase();
            return searchTerms.some(term => textToSearch.includes(term));
        });
        
        const cloudIds = new Set(cloudinaryMatches.map(p => p.id));
        searchResults = searchResults.filter(p => !cloudIds.has(p.id));

        searchResults = [...cloudinaryMatches, ...searchResults];

        res.json({ data: searchResults, hasMore: searchResults.length > 0 });
    } catch (error) {
        res.status(500).json({ error: "Search failed" });
    }
});

// 4. UPLOAD HANDLING
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
            cloudinaryFeed.unshift(newPin);
            io.emit('new_pin', newPin);
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const ReadableStream = new Readable();
    ReadableStream.push(req.file.buffer);
    ReadableStream.push(null);
    ReadableStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Personalized Smart Backend Active!"));
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));