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

cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// OPTIMIZED CACHE & STATE
// ==========================================
let cloudinaryFeed = [];
let globalShuffledFeed = []; // Shuffled ONCE during background cache update

function shuffleArray(array) {
    let mixed = [...array];
    for (let i = mixed.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    return mixed;
}

// ==========================================
// EXTERNAL API FETCHERS (WITH THUMBNAILS & DIMENSIONS)
// ==========================================
const FETCH_HEADERS = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' 
};

async function getCloudinaryPins() {
    try {
        const result = await cloudinary.api.resources({ type: 'upload', prefix: 'pinterest_feed/', max_results: 100, context: true });
        if (result && result.resources) {
            cloudinaryFeed = result.resources.map(res => ({
                id: res.asset_id,
                imageUrl: res.secure_url,
                // Cloudinary native on-the-fly thumbnail generation (width 400px, auto format/quality)
                thumbnailUrl: res.secure_url.replace('/upload/', '/upload/w_400,c_scale,q_auto,f_auto/'),
                title: res.context?.custom?.title || "Uploaded Pin",
                tags: res.tags || [],
                width: res.width || 400,
                height: res.height || 600,
                createdAt: res.created_at
            }));
        }
    } catch (e) { console.error("Cloudinary fetch error:", e.message); }
}

async function getRedditPins() {
    try {
        const res = await fetch('https://www.reddit.com/r/wallpapers+EarthPorn+DesignPorn+Amoledbackgrounds/hot.json?limit=40', { headers: FETCH_HEADERS });
        const json = await res.json();
        return json.data.children
            .filter(c => c.data && c.data.post_hint === 'image' && c.data.preview?.images?.[0])
            .map(c => {
                const imgData = c.data.preview.images[0];
                const highResUrl = imgData.source.url.replace(/&amp;/g, '&');
                // Find a medium resolution for the thumbnail
                const thumbData = imgData.resolutions.find(r => r.width >= 300) || imgData.resolutions[0] || imgData.source;
                return {
                    id: 'reddit_' + c.data.id,
                    imageUrl: highResUrl,
                    thumbnailUrl: thumbData.url.replace(/&amp;/g, '&'),
                    title: c.data.title.substring(0, 50),
                    tags: ['reddit', 'wallpaper'],
                    width: imgData.source.width,
                    height: imgData.source.height,
                    createdAt: new Date(c.data.created_utc * 1000).toISOString()
                };
            });
    } catch (e) { return []; }
}

async function getWallhavenPins(searchQuery = "") {
    try {
        const url = searchQuery 
            ? `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(searchQuery)}&sorting=relevance&purity=100&limit=30`
            : `https://wallhaven.cc/api/v1/search?sorting=random&purity=100&limit=30`;
        const res = await fetch(url, { headers: FETCH_HEADERS });
        const json = await res.json();
        return json.data.map(item => ({
            id: 'wallhaven_' + item.id,
            imageUrl: item.path,
            thumbnailUrl: item.thumbs.regular || item.thumbs.small, // Small thumbnail for feed
            title: searchQuery ? `Wallhaven ${searchQuery}` : "HD Wallpaper",
            tags: ['wallhaven', 'design'],
            width: item.dimension_x,
            height: item.dimension_y,
            createdAt: new Date().toISOString()
        }));
    } catch (e) { return []; }
}

async function getDanbooruPins(searchQuery = "") {
    try {
        const query = searchQuery ? encodeURIComponent(searchQuery.split(' ')[0] + ' rating:safe') : 'rating:safe';
        const res = await fetch(`https://danbooru.donmai.us/posts.json?limit=30&tags=${query}`, { headers: FETCH_HEADERS });
        const json = await res.json();
        return json
            .filter(item => item.large_file_url && item.image_width)
            .map(item => ({
                id: 'danbooru_' + item.id,
                imageUrl: item.large_file_url,
                thumbnailUrl: item.preview_file_url || item.large_file_url, // Highly compressed thumbnail
                title: "Anime Art",
                tags: ['danbooru', 'anime'],
                width: item.image_width,
                height: item.image_height,
                createdAt: item.created_at
            }));
    } catch (e) { return []; }
}

// ==========================================
// BACKGROUND POLLING (CPU EFFICIENT)
// ==========================================
async function buildGlobalFeed() {
    console.log("Refreshing background caches...");
    await getCloudinaryPins();
    const [reddit, wallhaven, danbooru] = await Promise.all([getRedditPins(), getWallhavenPins(), getDanbooruPins()]);
    
    // Combine and shuffle ONCE.
    const combined = [...cloudinaryFeed, ...reddit, ...wallhaven, ...danbooru];
    if (combined.length > 0) {
        globalShuffledFeed = shuffleArray(combined);
        console.log(`Cache updated. Mixed ${globalShuffledFeed.length} total pins. Ready to serve instantly.`);
    }
}
buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); // Re-fetch and re-shuffle every 10 mins

// ==========================================
// API ROUTES
// ==========================================

// PAGINATED FEED ENDPOINT
app.get('/api/pins', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const paginatedResults = globalShuffledFeed.slice(startIndex, endIndex);
    
    res.json({
        data: paginatedResults,
        currentPage: page,
        hasMore: endIndex < globalShuffledFeed.length,
        totalItems: globalShuffledFeed.length
    });
});

// SEARCH API (Uses mapping format)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ data: globalShuffledFeed.slice(0, 20), hasMore: false });

    try {
        const [wallhaven, danbooru] = await Promise.all([getWallhavenPins(query), getDanbooruPins(query)]);
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );

        const searchResults = shuffleArray([...cloudinaryMatches, ...wallhaven, ...danbooru]);
        res.json({ data: searchResults, hasMore: false }); // Limit search to 1 batch for performance
    } catch (error) {
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
                height: result.height || 600,
                createdAt: result.created_at
            };

            cloudinaryFeed.unshift(newPin);
            globalShuffledFeed.unshift(newPin); // Add to top of feed immediately
            io.emit('new_pin', newPin);
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => res.send("Optimized Backend Running! Pagination and Thumbnails active."));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));