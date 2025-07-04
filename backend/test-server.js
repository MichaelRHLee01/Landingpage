const express = require('express');
const app = express();

// Allow all CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', '*');
    next();
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
    res.json({ message: 'Test API is working!' });
});

// Start server
const PORT = 3333; // Use a different port entirely
app.listen(PORT, () => {
    console.log(`Test server running on http://localhost:${PORT}`);
});