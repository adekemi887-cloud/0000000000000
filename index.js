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

// Store keyword-specific caches: { "fashion": [...pins], "bag": [...pins] }
const keywordCache = {}; 

// Store user profiles: { "user_123": { seen: Set(), interests: { bag: 10, luxury: 5 } } }
const userProfiles = {}; 

const DEFAULT_TOPICS = ["minimalist aesthetic", "streetwear fashion", "interior design", "cinematic photography"];

// --- External API Fetchers ---
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
        console.log(`Fetching external APIs to build cache for: "${keyword}"`);
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

// 1. SMART PERSONALIZED FEED
app.get('/api/pins', async (req, res) => {
    const userId = req.query.userId || 'anonymous';
    const limit = parseInt(req.query.limit) || 20; 
    let incomingInterests = req.query.interests ? req.query.interests.split(',') : [];

    // Initialize user session
    if (!userProfiles[userId]) {
        userProfiles[userId] = { seen: new Set(), interests: {} };
    }
    const profile = userProfiles[userId];

    // Determine target keywords (Use user interests OR fallback to defaults)
    let targetKeywords = incomingInterests.length > 0 ? incomingInterests : Object.keys(profile.interests).sort((a, b) => profile.interests[b] - profile.interests[a]).slice(0, 3);
    if (targetKeywords.length === 0) targetKeywords = [DEFAULT_TOPICS[Math.floor(Math.random() * DEFAULT_TOPICS.length)]];

    // Ensure all target keywords have loaded caches
    await Promise.all(targetKeywords.map(kw => ensureKeywordCache(kw)));

    // Pool all matching pins together
    let availablePins = [...cloudinaryFeed];
    targetKeywords.forEach(kw => { if (keywordCache[kw]) availablePins.push(...keywordCache[kw]); });
    
    // Filter out ALREADY SEEN pins for this exact user!
    availablePins = availablePins.filter(pin => !profile.seen.has(pin.id));

    // Fallback: If they consumed everything, clear their history and restart
    if (availablePins.length < limit) {
        console.log(`User ${userId} consumed all content. Resetting seen history.`);
        profile.seen.clear();
        availablePins = [...cloudinaryFeed];
        targetKeywords.forEach(kw => { if (keywordCache[kw]) availablePins.push(...keywordCache[kw]); });
    }

    // Shuffle and slice
    const selectedPins = availablePins.sort(() => 0.5 - Math.random()).slice(0, limit);

    // Mark as seen
    selectedPins.forEach(pin => profile.seen.add(pin.id));

    res.json({
        data: selectedPins,
        hasMore: true
    });
});

// 2. LIVE SEARCH (DETERMINISTIC, NO ROTATION)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: [], hasMore: false });

    try {
        await ensureKeywordCache(query); // Ensure we have raw data
        let searchResults = [...keywordCache[query]];

        // Prepend local uploads matching the query
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );
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