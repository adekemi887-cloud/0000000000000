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
// CACHED MEMORY (NO SHUFFLING, JUST FAST INTERLEAVING)
// ==========================================
let cloudinaryFeed = [];
let mixedGlobalFeed = []; // Interleaved feed ready to serve instantly

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

// 2. Fetch from Reddit (Real User Titles, High Quality Photography/Art)
async function getRedditPins() {
    try {
        const res = await fetch('https://www.reddit.com/r/Art+itookapicture+DesignPorn+EarthPorn/hot.json?limit=50', { headers: FETCH_HEADERS });
        const json = await res.json();
        return json.data.children
            .filter(c => c.data && c.data.post_hint === 'image' && c.data.preview?.images?.[0])
            .map(c => {
                const imgData = c.data.preview.images[0];
                const thumbData = imgData.resolutions.find(r => r.width >= 320) || imgData.resolutions[0] || imgData.source;
                return {
                    id: 'reddit_' + c.data.id,
                    imageUrl: imgData.source.url.replace(/&amp;/g, '&'),
                    thumbnailUrl: thumbData.url.replace(/&amp;/g, '&'), // Very lightweight thumbnail
                    title: c.data.title.substring(0, 70), // Real post title!
                    tags: ['reddit', c.data.subreddit.toLowerCase()],
                    width: thumbData.width,
                    height: thumbData.height
                };
            });
    } catch (e) { return []; }
}

// 3. Fetch from Art Institute of Chicago (Public API, Real Artwork Titles, Highly Compressible)
async function getArtInstitutePins() {
    try {
        const res = await fetch('https://api.artic.edu/api/v1/artworks?limit=50&fields=id,title,image_id,thumbnail');
        const json = await res.json();
        return json.data
            .filter(item => item.image_id && item.thumbnail)
            .map(item => ({
                id: 'art_' + item.id,
                imageUrl: `https://www.artic.edu/iiif/2/${item.image_id}/full/843,/0/default.jpg`,
                thumbnailUrl: `https://www.artic.edu/iiif/2/${item.image_id}/full/400,/0/default.jpg`, // Request exactly 400px wide
                title: item.title, // Real artwork title!
                tags: ['art', 'museum', 'aesthetic'],
                width: item.thumbnail.width || 400,
                height: item.thumbnail.height || 600
            }));
    } catch (e) { return []; }
}

// ==========================================
// BACKGROUND CACHE BUILDER (FAST LINEAR INTERLEAVING)
// ==========================================
async function buildGlobalFeed() {
    console.log("Fetching background caches...");
    await getCloudinaryPins();
    
    // Fetch external sources concurrently
    const [reddit, museumArt] = await Promise.all([getRedditPins(), getArtInstitutePins()]);
    
    const interleavedFeed = [];
    const maxLength = Math.max(cloudinaryFeed.length, reddit.length, museumArt.length);
    
    // Mix perfectly: [Cloudinary1, Reddit1, Art1, Cloudinary2, Reddit2, Art2...]
    // O(N) complexity - extremely fast, NO CPU heavy Math.random() shuffling
    for (let i = 0; i < maxLength; i++) {
        if (cloudinaryFeed[i]) interleavedFeed.push(cloudinaryFeed[i]);
        if (reddit[i]) interleavedFeed.push(reddit[i]);
        if (museumArt[i]) interleavedFeed.push(museumArt[i]);
    }
    
    if (interleavedFeed.length > 0) {
        mixedGlobalFeed = interleavedFeed;
        console.log(`Successfully mixed ${mixedGlobalFeed.length} lightweight pins.`);
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
    const limit = parseInt(req.query.limit) || 20; // Send exactly 20 items per scroll
    
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    res.json({
        data: mixedGlobalFeed.slice(startIndex, endIndex),
        currentPage: page,
        hasMore: endIndex < mixedGlobalFeed.length
    });
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

            // Inject uploaded pin to the very top of both feeds immediately
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

app.get('/', (req, res) => res.send("Optimized Backend Running! Reddit & Museum APIs Active. No Shuffling."));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));