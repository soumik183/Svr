const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

// --- 1. ROBUST ENVIRONMENT LOADING (Debug Section) ---
console.log("--- STARTING SERVER ---");
const envPath = path.join(__dirname, '.env');
console.log(`Looking for .env file at: ${envPath}`);

if (fs.existsSync(envPath)) {
    console.log("✅ .env file found.");
    require('dotenv').config({ path: envPath });
} else {
    console.error("❌ .env file NOT found. Please create it in the same folder as server.js");
}

// Check Keys
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

console.log(`Supabase URL Status: ${SUPABASE_URL ? '✅ Loaded' : '❌ Missing'}`);
console.log(`Supabase Key Status: ${SUPABASE_KEY ? '✅ Loaded' : '❌ Missing'}`);

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("\nCRITICAL ERROR: Stopping server because API keys are missing.");
    console.error("Fix: Create a file named .env and add SUPABASE_URL and SUPABASE_KEY inside it.\n");
    process.exit(1);
}

// --- 2. SERVER SETUP ---
const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // RAM Storage
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(morgan('dev')); // Logger
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve HTML/CSS/JS
app.use(express.static('public'));
app.use(express.static('views'));

// --- 3. VIEW ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'views/auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'views/dashboard.html')));
app.get('/gallery', (req, res) => res.sendFile(path.join(__dirname, 'views/gallery.html')));
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, 'views/upload.html')));

// --- 4. AUTH ROUTES ---

// Register
app.post('/api/auth/register', async (req, res) => {
    const { email, password, username } = req.body;
    try {
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { username } }
        });
        if (error) throw error;
        res.json({ message: 'Success', user: data.user });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Login (Fixes "No Token" issue)
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body; // Frontend sends "username" input
    
    // Check if input is empty
    if(!username || !password) {
        return res.status(400).json({ error: "Email and password required" });
    }

    console.log(`Login attempt for: ${username}`);

    try {
        // We assume the user typed their Email in the "Username" box
        const { data, error } = await supabase.auth.signInWithPassword({
            email: username, 
            password: password
        });

        if (error) throw error;

        // Check if session exists (Handles "Email not confirmed" case)
        if (!data.session) {
            console.log("❌ Login correct, but NO SESSION. Email not confirmed?");
            return res.status(403).json({ 
                error: 'Login successful but access denied. Please disable "Confirm Email" in Supabase.' 
            });
        }

        console.log("✅ Login success. Token generated.");
        res.json({
            message: 'Login success',
            token: data.session.access_token,
            user: data.user
        });

    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(401).json({ error: err.message });
    }
});

// Logout
app.post('/api/auth/logout', async (req, res) => {
    await supabase.auth.signOut();
    res.json({ message: 'Logged out' });
});

// --- 5. FILE ROUTES ---

// Upload
app.post('/api/files/upload', upload.array('files'), async (req, res) => {
    // 1. Check Auth Header
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No Authorization header' });
    
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) return res.status(401).json({ error: 'Invalid Token' });

    // 2. Process Files
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });

    const results = [];
    try {
        for (const file of req.files) {
            // A. Upload to Storage
            const fileExt = file.originalname.split('.').pop();
            const filePath = `${user.id}/${Date.now()}_${Math.random().toString(36).substr(2,9)}.${fileExt}`;
            
            const { error: storageError } = await supabase.storage
                .from('vault') // Make sure this bucket exists!
                .upload(filePath, file.buffer, { contentType: file.mimetype });

            if (storageError) throw storageError;

            // B. Get URL
            const { data: { publicUrl } } = supabase.storage.from('vault').getPublicUrl(filePath);

            // C. Save to DB
            const type = file.mimetype.startsWith('image/') ? 'image' 
                       : file.mimetype.startsWith('video/') ? 'video' 
                       : 'application';

            const { data: dbData, error: dbError } = await supabase
                .from('media_files') // Make sure this table exists!
                .insert([{
                    user_id: user.id,
                    name: file.originalname,
                    size: file.size,
                    type: type,
                    url: publicUrl,
                    storage_path: filePath
                }])
                .select();

            if (dbError) throw dbError;
            results.push(dbData[0]);
        }
        res.json({ message: 'Upload success', files: results });
    } catch (err) {
        console.error("Upload failed:", err);
        res.status(500).json({ error: err.message });
    }
});

// List Files
app.get('/api/files', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(401).json({ error: 'Invalid user' });

    try {
        const { data, error: dbError } = await supabase
            .from('media_files')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (dbError) throw dbError;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.json([]); // Return empty array on error to prevent frontend crash
    }
});

// Delete File
app.delete('/api/files/:id', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    try {
        // Get path
        const { data: file } = await supabase.from('media_files').select('storage_path').eq('id', req.params.id).single();
        if (file) {
            // Delete from storage
            await supabase.storage.from('vault').remove([file.storage_path]);
        }
        // Delete from DB
        await supabase.from('media_files').delete().eq('id', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Storage Nodes Mock
app.get('/api/storage/nodes', (req, res) => {
    res.json([{ id: 'default', name: 'Primary Vault', bucket_name: 'vault' }]);
});

// --- 6. START ---
app.listen(PORT, () => {
    console.log(`\n✅ SERVER RUNNING: http://localhost:${PORT}`);
    console.log(`👉 Login at: http://localhost:${PORT}/auth`);
});