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

// Default modern topics to keep the feed constantly fresh and visually appealing
const AESTHETIC_TOPICS = [
    "minimalist workspace setup", 
    "streetwear fashion outfit", 
    "3d blender abstract design", 
    "cozy modern interior room",
    "cinematic portrait photography",
    "neon cyberpunk aesthetic",
    "vintage film photography",
    "luxurious modern architecture"
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

// 2. Fetch from Lexica.art
async function getLexicaPins(searchQuery = "") {
    try {
        const query = searchQuery || AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)];
        const res = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        
        return json.images.slice(0, 40).map(img => ({
            id: 'lexica_' + img.id + '_' + Date.now(), // Unique ID generation
            imageUrl: img.src,
            thumbnailUrl: img.srcSmall, 
            title: img.prompt.split(',')[0].substring(0, 70), 
            tags: ['aesthetic', 'modern', query.split(' ')[0]],
            width: img.width,
            height: img.height
        }));
    } catch (e) { 
        console.error("Lexica error:", e.message); 
        return []; 
    }
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
    
    const [lexica, flickr] = await Promise.all([getLexicaPins(), getFlickrPins()]);
    
    const interleavedFeed = [];
    const maxLength = Math.max(cloudinaryFeed.length, lexica.length, flickr.length);
    
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

buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); 

// ==========================================
// API ROUTES
// ==========================================

// FAST FEED PAGINATION WITH INFINITE GENERATION
app.get('/api/pins', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    
    // Rotate array slightly on Page 1 so that refreshing gives NEW content every time!
    if (page === 1 && mixedGlobalFeed.length > limit) {
        const rotation = Math.floor(Math.random() * 25) + 5; 
        mixedGlobalFeed = [...mixedGlobalFeed.slice(rotation), ...mixedGlobalFeed.slice(0, rotation)];
    }

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    // TRUE INFINITE SCROLL: If user scrolls past our cache length, dynamically fetch MORE!
    if (endIndex > mixedGlobalFeed.length) {
        console.log("Expanding global feed for infinite scroll...");
        const [lexica, flickr] = await Promise.all([getLexicaPins(), getFlickrPins()]);
        
        const newMix = [];
        const maxLength = Math.max(lexica.length, flickr.length);
        for (let i = 0; i < maxLength; i++) {
            if (lexica[i]) newMix.push(lexica[i]);
            if (flickr[i]) newMix.push(flickr[i]);
        }
        
        // Prevent duplicate IDs
        const existingIds = new Set(mixedGlobalFeed.map(p => p.id));
        const uniqueNewMix = newMix.filter(p => !existingIds.has(p.id));
        
        mixedGlobalFeed.push(...uniqueNewMix);
        
        // Failsafe: if APIs limit us, recycle existing ones with new IDs to keep feed alive forever
        if (uniqueNewMix.length < limit) {
            const recycled = mixedGlobalFeed.slice(0, limit).map(p => ({...p, id: p.id + '_recycle_' + Date.now()}));
            mixedGlobalFeed.push(...recycled);
        }
    }
    
    res.json({
        data: mixedGlobalFeed.slice(startIndex, endIndex),
        currentPage: page,
        hasMore: true // ALWAYS true for infinite scroll
    });
});

// TRUE GLOBAL SEARCH WITH LIVE API FETCHING
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const page = parseInt(req.query.page) || 1;

    if (!query) {
        return res.json({ data: mixedGlobalFeed.slice(0, 20), hasMore: true });
    }

    try {
        // If scrolling deep in a search, append random aesthetic modifiers so it fetches fresh content from external APIs
        const queryVariant = page > 1 ? `${query} ${AESTHETIC_TOPICS[Math.floor(Math.random() * AESTHETIC_TOPICS.length)]}` : query;

        // Perform LIVE Search across external databases using the exact keyword!
        const [lexicaMatches, flickrMatches] = await Promise.all([
            getLexicaPins(queryVariant),
            getFlickrPins(queryVariant)
        ]);

        const searchResults = [];
        const maxLength = Math.max(lexicaMatches.length, flickrMatches.length);
        
        for (let i = 0; i < maxLength; i++) {
            if (lexicaMatches[i]) searchResults.push(lexicaMatches[i]);
            if (flickrMatches[i]) searchResults.push(flickrMatches[i]);
        }

        // Add Local Uploads to top, only on page 1
        if (page === 1) {
            const cloudinaryMatches = cloudinaryFeed.filter(pin => 
                (pin.title && pin.title.toLowerCase().includes(query.toLowerCase())) ||
                (pin.tags && pin.tags.some(tag => tag.toLowerCase().includes(query.toLowerCase())))
            );
            searchResults.unshift(...cloudinaryMatches);
        }

        res.json({ 
            data: searchResults, 
            hasMore: searchResults.length > 0 // Keep allowing pagination if it found results
        });
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

app.get('/', (req, res) => res.send("Optimized Backend Running! True Infinite Scroll & Live Search Active."));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));