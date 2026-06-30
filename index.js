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
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Hardcoded Cloudinary Configuration
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

// Configure Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

let feedData = [];

// Fetch existing pins from Cloudinary on Server Startup
async function loadExistingPins() {
    try {
        console.log("Fetching existing images from Cloudinary...");
        const result = await cloudinary.api.resources({
            type: 'upload',
            prefix: 'pinterest_feed/',
            max_results: 100,
            tags: true,
            context: true
        });
        
        if (result && result.resources) {
            feedData = result.resources.map(res => ({
                id: res.asset_id,
                imageUrl: res.secure_url,
                title: res.context?.custom?.title || "Untitled",
                tags: res.tags || [],
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: res.created_at
            }));
            
            feedData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            console.log(`Successfully loaded ${feedData.length} pins from Cloudinary.`);
        }
    } catch (error) {
        console.error("Notice: Could not load initial pins. This is normal if the Cloudinary folder is empty.", error.message);
    }
}
loadExistingPins();

// API ROUTES

app.get('/api/pins', (req, res) => {
    res.json(feedData);
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
    }
    
    const title = req.body.title || 'New Pin';
    const tags = req.body.tags ? req.body.tags.split(',').map(tag => tag.trim()) : [];
    
    const uploadStream = cloudinary.uploader.upload_stream(
        {
            folder: "pinterest_feed",
            tags: tags,
            context: `title=${title}`
        },
        (error, result) => {
            if (error) {
                console.error("Cloudinary Upload Error:", error);
                return res.status(500).json({ error: "Upload failed" });
            }
            
            const newPin = {
                id: result.asset_id,
                imageUrl: result.secure_url,
                title: title,
                tags: tags,
                height: Math.floor(Math.random() * (350 - 180 + 1) + 180),
                createdAt: result.created_at
            };
            
            feedData.unshift(newPin);
            
            // Broadcast new pin to frontend instantly
            io.emit('new_pin', newPin);
            
            res.status(201).json({ message: "Upload successful", pin: newPin });
        }
    );
    
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);
    bufferStream.pipe(uploadStream);
});

app.get('/', (req, res) => {
    res.send("Pinterest Backend Server is running successfully!");
});

// Prevent server crash on unexpected errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// START THE SERVER
const PORT = process.env.PORT || 5000;

// Binding to '0.0.0.0' guarantees it works smoothly on Render
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
}).on('error', (err) => {
    console.error('Failed to start server. Port might be in use:', err);
});