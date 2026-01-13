/**
 * Genesys Cloud Disconnect Tool - Backend Server
 * Handles CORS and proxies requests to Genesys Cloud API
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Environment variables for default credentials (optional)
const defaultCredentials = {
    clientId: process.env.GENESYS_CLOUD_CLIENT_ID || '',
    clientSecret: process.env.GENESYS_CLOUD_CLIENT_SECRET || '',
    region: process.env.GENESYS_CLOUD_REGION || 'mypurecloud.de'
};

// API endpoint to get default credentials
app.get('/api/config', (req, res) => {
    res.json({
        clientId: defaultCredentials.clientId,
        region: defaultCredentials.region,
        // Don't expose secret in GET request
        hasSecret: !!defaultCredentials.clientSecret
    });
});

// Proxy endpoint for authentication
app.post('/api/auth', async (req, res) => {
    const { clientId, clientSecret, region } = req.body;

    try {
        const authUrl = `https://login.${region}/oauth/token`;
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const response = await fetch(authUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
            const error = await response.text();
            return res.status(response.status).json({ error });
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy endpoint for Genesys API calls
app.all('/api/proxy/*', async (req, res) => {
    const token = req.headers.authorization;
    const region = req.headers['x-gc-region'] || 'mypurecloud.de';

    if (!token) {
        return res.status(401).json({ error: 'No authorization token provided' });
    }

    // Extract the actual API path
    const apiPath = req.params[0];
    const url = `https://api.${region}/${apiPath}`;

    try {
        const fetchOptions = {
            method: req.method,
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            }
        };

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
            fetchOptions.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, fetchOptions);
        const contentType = response.headers.get('content-type');

        if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            res.status(response.status).json(data);
        } else {
            const text = await response.text();
            res.status(response.status).send(text);
        }
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🔌 Genesys Cloud Disconnect Tool                           ║
║                                                               ║
║   Server running at: http://localhost:${PORT}                    ║
║                                                               ║
║   Open the URL above in your browser to use the tool.        ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `);
});
