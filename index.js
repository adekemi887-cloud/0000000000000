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

// 2. Fetch from Picsum (Provides high-quality modern Unsplash photography)
async function getPicsumPins() {
    try {
        // Grab a random page so it changes every time the cache updates
        const randomPage = Math.floor(Math.random() * 10) + 1;
        const res = await fetch(`https://picsum.photos/v2/list?page=${randomPage}&limit=40`);
        const json = await res.json();
        
        return json.map(img => {
            // Calculate proportional height for a 400px wide thumbnail
            const ratio = img.height / img.width;
            const thumbHeight = Math.floor(400 * ratio);
            
            return {
                id: 'picsum_' + img.id,
                imageUrl: img.download_url, // Full size high-res
                thumbnailUrl: `https://picsum.photos/id/${img.id}/400/${thumbHeight}`, // Compressed thumbnail
                title: `Photography by ${img.author}`, // Real artist names
                tags: ['photography', 'aesthetic', 'modern'],
                width: img.width,
                height: img.height
            };
        });
    } catch (e) { 
        console.error("Picsum error:", e.message); 
        return []; 
    }
}

// 3. Fetch from Flickr (Great for targeted aesthetic searches without API keys)
async function getFlickrPins(searchQuery = 'fashion,workspace,technology,aesthetic') {
    try {
        // Flickr's public feed allows tag searching without API keys and doesn't block Render
        const res = await fetch(`https://api.flickr.com/services/feeds/photos_public.gne?tags=${encodeURIComponent(searchQuery)}&format=json&nojsoncallback=1`);
        const json = await res.json();
        
        return json.items.map((item, index) => {
            // Flickr returns small "_m" urls. We swap them for medium "_z" and large "_b"
            const thumbUrl = item.media.m.replace('_m.jpg', '_z.jpg'); 
            const largeUrl = item.media.m.replace('_m.jpg', '_b.jpg');
            
            return {
                id: 'flickr_' + Date.now() + '_' + index,
                imageUrl: largeUrl,
                thumbnailUrl: thumbUrl,
                title: item.title ? item.title.substring(0, 60) : "Inspiration", // Real user titles
                tags: item.tags ? item.tags.split(' ').slice(0, 3) : [searchQuery],
                width: 400, // Flickr public doesn't provide exact dimensions, standardizing width
                height: Math.floor(Math.random() * (350 - 200 + 1) + 200) // Masonry variation
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
    console.log("Refreshing background caches...");
    await getCloudinaryPins();
    
    // Fetch external sources concurrently
    const [picsum, flickr] = await Promise.all([getPicsumPins(), getFlickrPins()]);
    
    const interleavedFeed = [];
    const maxLength = Math.max(cloudinaryFeed.length, picsum.length, flickr.length);
    
    // Interleave seamlessly: [Cloudinary, Picsum, Flickr, Cloudinary, Picsum...]
    for (let i = 0; i < maxLength; i++) {
        if (cloudinaryFeed[i]) interleavedFeed.push(cloudinaryFeed[i]);
        if (picsum[i]) interleavedFeed.push(picsum[i]);
        if (flickr[i]) interleavedFeed.push(flickr[i]);
    }
    
    if (interleavedFeed.length > 0) {
        mixedGlobalFeed = interleavedFeed;
        console.log(`Successfully mixed ${mixedGlobalFeed.length} high-quality pins.`);
    }
}

// Initial load, then refresh every 10 minutes
buildGlobalFeed();
setInterval(buildGlobalFeed, 10 * 60 * 1000); 

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

// LIVE SEARCH 
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

        // 2. Perform Live Search on Flickr (e.g. searching "clothes" or "software developer" works!)
        const flickrMatches = await getFlickrPins(query);

        // Mix local uploads with global search results
        const searchResults = [];
        const maxLength = Math.max(cloudinaryMatches.length, flickrMatches.length);
        
        for (let i = 0; i < maxLength; i++) {
            if (cloudinaryMatches[i]) searchResults.push(cloudinaryMatches[i]);
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

app.get('/', (req, res) => res.send("Optimized Backend Running! Unsplash Imagery & Live Search Active."));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));