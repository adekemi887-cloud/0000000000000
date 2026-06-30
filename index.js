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
// CACHED MEMORY (FAST INTERLEAVING)
// ==========================================
let cloudinaryFeed = [];
let mixedGlobalFeed = []; 

const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36' };

// 1. Fetch from Cloudinary
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
        }
    } catch (e) { console.error("Cloudinary error:", e.message); }
}

// Helper: Extract valid, safe, lightweight images from Reddit JSON
function extractRedditImages(children) {
    return children
        .filter(c => c.data && !c.data.over_18 && c.data.post_hint === 'image' && c.data.preview?.images?.[0])
        .map(c => {
            const imgData = c.data.preview.images[0];
            const thumbData = imgData.resolutions.find(r => r.width >= 320) || imgData.resolutions[0] || imgData.source;
            return {
                id: 'reddit_' + c.data.id,
                imageUrl: imgData.source.url.replace(/&amp;/g, '&'),
                thumbnailUrl: thumbData.url.replace(/&amp;/g, '&'), 
                title: c.data.title.substring(0, 80), // Real authentic titles
                tags: ['aesthetic', c.data.subreddit?.toLowerCase() || 'search'],
                width: thumbData.width,
                height: thumbData.height
            };
        });
}

// 2. Fetch "Pinterest-Vibe" Content (Fashion, Tech, 3D, Interiors, Portraits)
async function getAestheticPins() {
    try {
        // Highly curated list of subreddits that match Pinterest's modern aesthetic exactly
        const subreddits = 'streetwear+OUTFITS+battlestations+blender+midjourney+RoomPorn+FoodPorn+portraits+CozyPlaces';
        const res = await fetch(`https://www.reddit.com/r/${subreddits}/hot.json?limit=80`, { headers: FETCH_HEADERS });
        const json = await res.json();
        return extractRedditImages(json.data.children);
    } catch (e) { return []; }
}

// ==========================================
// BACKGROUND CACHE BUILDER
// ==========================================
async function buildGlobalFeed() {
    console.log("Fetching background caches...");
    await getCloudinaryPins();
    const aestheticPins = await getAestheticPins();
    
    const interleavedFeed = [];
    const maxLength = Math.max(cloudinaryFeed.length, aestheticPins.length);
    
    // Mix perfectly: [Cloudinary, Pinterest-Vibe, Cloudinary, Pinterest-Vibe...]
    for (let i = 0; i < maxLength; i++) {
        if (cloudinaryFeed[i]) interleavedFeed.push(cloudinaryFeed[i]);
        if (aestheticPins[i]) interleavedFeed.push(aestheticPins[i]);
    }
    
    if (interleavedFeed.length > 0) {
        mixedGlobalFeed = interleavedFeed;
        console.log(`Successfully mixed ${mixedGlobalFeed.length} modern aesthetic pins.`);
    }
}

buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); // Re-fetch every 10 mins

// ==========================================
// API ROUTES
// ==========================================

// FAST FEED PAGINATION
app.get('/api/pins', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    res.json({
        data: mixedGlobalFeed.slice(startIndex, endIndex),
        currentPage: page,
        hasMore: endIndex < mixedGlobalFeed.length
    });
});

// LIVE SEARCH (Finds actual matching images for whatever the user searches)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.json({ data: mixedGlobalFeed.slice(0, 20), hasMore: false });
    }

    try {
        // 1. Search Cloudinary Local Uploads
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );

        // 2. Search Global Reddit for precise user queries (e.g., "clothes", "software developer")
        // nsfw:no ensures it stays professional and clean
        const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}+nsfw:no&sort=relevance&limit=30`;
        const redditRes = await fetch(searchUrl, { headers: FETCH_HEADERS });
        const redditJson = await redditRes.json();
        const globalMatches = extractRedditImages(redditJson.data.children);

        // Mix local uploads with global search results
        const searchResults = [];
        const maxLength = Math.max(cloudinaryMatches.length, globalMatches.length);
        for (let i = 0; i < maxLength; i++) {
            if (cloudinaryMatches[i]) searchResults.push(cloudinaryMatches[i]);
            if (globalMatches[i]) searchResults.push(globalMatches[i]);
        }

        res.json({ data: searchResults, hasMore: false });
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
                imageUrl: result.secure_url,
                thumbnailUrl: result.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: title,
                width: result.width || 400,
                height: result.height || 600
            };

            cloudinaryFeed.unshift(newPin);
            mixedGlobalFeed.unshift(newPin); 
            
            io.emit('new_pin', newPin);
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Optimized Backend Running! Modern Aesthetics & Global Search Active."));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));