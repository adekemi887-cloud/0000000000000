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

// Default modern topics to make the home feed look exactly like Pinterest
const AESTHETIC_TOPICS = [
    "minimalist workspace setup", 
    "streetwear fashion outfit", 
    "3d blender abstract design", 
    "cozy modern interior room",
    "cinematic portrait photography",
    "neon cyberpunk aesthetic"
];

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

// 2. Fetch from Lexica.art (Stunning Modern 3D, Fashion, Tech, Architecture)
// Returns real descriptive prompts as titles!
async function getLexicaPins(searchQuery = "") {
    try {
        // If no search query, pick a random aesthetic topic for the home feed
        const query = searchQuery || AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        
        return json.images.slice(0, 40).map(img => ({
            id: 'lexica_' + img.id,
            imageUrl: img.src,
            thumbnailUrl: img.srcSmall, // Lexica provides highly compressed thumbnails natively
            title: img.prompt.split(',')[0].substring(0, 70), // Use the first part of the prompt as a clean title
            tags: ['aesthetic', 'modern', query.split(' ')[0]],
            width: img.width,
            height: img.height
        }));
    } catch (e) { 
        console.error("Lexica error:", e.message); 
        return []; 
    }
}

// 3. Fetch from Flickr (Real world photography, architecture, fashion)
async function getFlickrPins(searchQuery = "") {
    try {
        const query = searchQuery || "aesthetic,fashion,architecture";
        const res = await fetch(`https://api.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(query)}&format=json&nojsoncallback=1`);
        const json = await res.json();
        
        return json.items.map((item, index) => {
            const thumbUrl = item.media.m.replace('_m.jpg', '_z.jpg'); 
            const largeUrl = item.media.m.replace('_m.jpg', '_b.jpg');
            
            // Clean up Flickr titles (remove dates/camera names often found in titles)
            let cleanTitle = item.title ? item.title.trim() : "Inspiration";
            if (cleanTitle.toLowerCase().includes('dsc') || cleanTitle.toLowerCase().includes('img')) {
                cleanTitle = "Aesthetic Photography";
            }
            
            return {
                id: 'flickr_' + Date.now() + '_' + index,
                imageUrl: largeUrl,
                thumbnailUrl: thumbUrl,
                title: cleanTitle.substring(0, 60),
                tags: item.tags ? item.tags.split(' ').slice(0, 3) : [],
                width: 400, 
                height: Math.floor(Math.random() * (350 - 200 + 1) + 200) 
            };
        });
    } catch (e) { 
        console.error("Flickr error:", e.message); 
        return []; 
    }
}

// ==========================================
// BACKGROUND CACHE BUILDER
// ==========================================
async function buildGlobalFeed() {
    console.log("Refreshing background caches with modern content...");
    await getCloudinaryPins();
    
    // Fetch external sources concurrently
    const [lexica, flickr] = await Promise.all([getLexicaPins(), getFlickrPins()]);
    
    const interleavedFeed = [];
    const maxLength = Math.max(cloudinaryFeed.length, lexica.length, flickr.length);
    
    // Interleave seamlessly
    for (let i = 0; i < maxLength; i++) {
        if (cloudinaryFeed[i]) interleavedFeed.push(cloudinaryFeed[i]);
        if (lexica[i]) interleavedFeed.push(lexica[i]);
        if (flickr[i]) interleavedFeed.push(flickr[i]);
    }
    
    if (interleavedFeed.length > 0) {
        mixedGlobalFeed = interleavedFeed;
        console.log(`Successfully mixed ${mixedGlobalFeed.length} highly aesthetic pins.`);
    }
}

// Initial load, then refresh every 10 minutes
buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); 

// ==========================================
// API ROUTES
// ==========================================

// FAST FEED PAGINATION (For Home Page)
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

// TRUE GLOBAL SEARCH (Actively searches databases based on user keyword)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.json({ data: mixedGlobalFeed.slice(0, 20), hasMore: false });
    }

    try {
        // 1. Search Local Uploads
        const cloudinaryMatches = cloudinaryFeed.filter(pin => 
            (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
            (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
        );

        // 2. Perform LIVE Search across external databases using the user's exact keyword!
        const [lexicaMatches, flickrMatches] = await Promise.all([
            getLexicaPins(query),
            getFlickrPins(query)
        ]);

        // Interleave the matching search results
        const searchResults = [];
        const maxLength = Math.max(cloudinaryMatches.length, lexicaMatches.length, flickrMatches.length);
        
        for (let i = 0; i < maxLength; i++) {
            if (cloudinaryMatches[i]) searchResults.push(cloudinaryMatches[i]);
            if (lexicaMatches[i]) searchResults.push(lexicaMatches[i]);
            if (flickrMatches[i]) searchResults.push(flickrMatches[i]);
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

            // Inject uploaded pin to the very top immediately
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

app.get('/', (req, res) => res.send("Optimized Backend Running! Lexica.art & True Global Search Active."));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));