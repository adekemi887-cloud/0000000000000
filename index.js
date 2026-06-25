const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();

// Set the port for Render (Render automatically provides process.env.PORT)
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows your front-end to connect to this server
app.use(express.json());

// --- HARDCODED CLOUDINARY CONFIGURATION ---
// As requested, hardcoded for testing. 
cloudinary.config({
    cloud_name: 'dyhhksvot',
    api_key: '843162796934642',
    api_secret: 'BZuIO8S5N9JxNB_zTDRRbRf6j2U'
});

// Configure Multer to keep uploaded files in memory (Required for Render)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// ROUTES
// ==========================================

// 1. Health Check Route (To see if Render deployed successfully)
app.get('/', (req, res) => {
    res.send('✅ Cloudinary Node.js Server is Running!');
});

// 2. Fetch Feed & Search Route
app.get('/api/feed', async (req, res) => {
    try {
        const searchTag = req.query.search;
        
        // Base expression: get all images
        let expression = 'resource_type:image';
        
        // If the user typed something in the search bar, filter by that tag
        if (searchTag) {
            expression += ` AND tags="${searchTag}"`;
        }
        
        // Use the powerful Admin Search API
        const result = await cloudinary.search
            .expression(expression)
            .sort_by('uploaded_at', 'desc') // Newest first
            .max_results(50) // Grab up to 50 pins at a time
            .with_field('tags')
            .execute();
        
        res.json({ success: true, pins: result.resources });
    } catch (error) {
        console.error("Error fetching feed:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Upload Image Route
app.post('/api/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No image provided.' });
        }
        
        const tag = req.body.tag ? req.body.tag.toLowerCase() : 'untagged';
        
        // Create an upload stream to Cloudinary directly from memory
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                tags: [tag] // Add the search tag directly to the image
            },
            (error, result) => {
                if (error) {
                    console.error("Cloudinary upload error:", error);
                    return res.status(500).json({ success: false, message: 'Upload failed.' });
                }
                
                // Send success response back to front-end instantly
                res.json({
                    success: true,
                    pin: result // Send back the new image data so front-end can display it instantly
                });
            }
        );
        
        // Feed the file buffer into the stream
        uploadStream.end(req.file.buffer);
        
    } catch (error) {
        console.error("Server error during upload:", error);
        res.status(500).json({ success: false, message: 'Server error during upload.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});