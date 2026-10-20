/**
 * Local Genesys Cloud helper. This server is intended to run on loopback for
 * one user; it deliberately exposes only the small set of assets and API
 * operations used by the browser UI.
 */

const express = require('express');
const path = require('path');
require('dotenv').config();

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const JSON_LIMIT = '16kb';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CREDENTIAL_LENGTH = 4096;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const REGIONS = new Set([
    'mypurecloud.de', 'mypurecloud.com', 'mypurecloud.ie', 'mypurecloud.com.au',
    'mypurecloud.jp', 'usw2.pure.cloud', 'cac1.pure.cloud', 'sae1.pure.cloud',
    'euw2.pure.cloud', 'aps1.pure.cloud', 'apne2.pure.cloud', 'apne3.pure.cloud',
    'mec1.pure.cloud', 'use2.us-gov-pure.cloud'
]);
const PUBLIC_ASSETS = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/app.js', 'app.js'],
    ['/styles.css', 'styles.css'],
    ['/badge.png', 'badge.png'],
    ['/csv-utils.js', 'csv-utils.js']
]);

function createApp({ env = process.env, fetchImpl = fetch } = {}) {
    const app = express();
    const configuredHost = typeof env.HOST === 'string' && env.HOST.trim() ? env.HOST.trim() : '127.0.0.1';
    const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(configuredHost)) {
        const host = hostnameFromAuthority(configuredHost);
        if (host) allowedHosts.add(host);
    }
    const defaultCredentials = {
        clientId: typeof env.GENESYS_CLOUD_CLIENT_ID === 'string' ? env.GENESYS_CLOUD_CLIENT_ID : '',
        clientSecret: typeof env.GENESYS_CLOUD_CLIENT_SECRET === 'string' ? env.GENESYS_CLOUD_CLIENT_SECRET : '',
        region: typeof env.GENESYS_CLOUD_REGION === 'string' ? env.GENESYS_CLOUD_REGION : 'mypurecloud.de'
    };
    if (!REGIONS.has(defaultCredentials.region)) {
        throw new Error(`Unsupported GENESYS_CLOUD_REGION: ${defaultCredentials.region}`);
    }

    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        const requestHost = hostnameFromAuthority(req.get('host'));
        if (!requestHost || !allowedHosts.has(requestHost)) return sendError(res, 403, 'Host is not allowed');
        next();
    });
    app.use(express.json({ limit: JSON_LIMIT, strict: true }));

    app.get('/api/health', (req, res) => res.json({ ok: true }));

    app.get('/api/config', (req, res) => {
        res.json({
            clientId: defaultCredentials.clientId,
            region: defaultCredentials.region,
            hasSecret: Boolean(defaultCredentials.clientSecret)
        });
    });

    for (const [url, filename] of PUBLIC_ASSETS) {
        app.get(url, (req, res) => res.sendFile(path.join(__dirname, filename)));
    }

    app.post('/api/auth', async (req, res) => {
        if (!checkOrigin(req, res)) return;
        const { clientId, region } = req.body || {};
        const suppliedSecret = req.body && req.body.clientSecret;
        if (!isBoundedString(clientId, 1, 256) || !isBoundedString(region, 1, 128)) {
            return sendError(res, 400, 'clientId and region must be non-empty strings within the allowed length');
        }
        if (!REGIONS.has(region)) return sendError(res, 400, 'Unsupported Genesys Cloud region');

        let clientSecret = suppliedSecret;
        if (clientSecret === undefined || clientSecret === '') {
            if (clientId !== defaultCredentials.clientId || region !== defaultCredentials.region || !defaultCredentials.clientSecret) {
                return sendError(res, 400, 'clientSecret is required unless matching server credentials are configured');
            }
            clientSecret = defaultCredentials.clientSecret;
        }
        if (!isBoundedString(clientSecret, 1, MAX_CREDENTIAL_LENGTH)) {
            return sendError(res, 400, 'clientSecret must be a non-empty string within the allowed length');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(`https://login.${region}/oauth/token`, {
                method: 'POST',
                redirect: 'error',
                signal: controller.signal,
                headers: {
                    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'grant_type=client_credentials'
            });
            const payload = await readPayload(response);
            if (!response.ok) {
                return sendError(res, response.status, 'Genesys authentication failed', response.headers.get('retry-after'));
            }
            if (!payload || typeof payload.access_token !== 'string' || payload.access_token.length === 0 ||
                !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
                return sendError(res, 502, 'Genesys returned an invalid authentication response');
            }
            return res.status(response.status).json({ access_token: payload.access_token, expires_in: payload.expires_in });
        } catch (error) {
            return sendError(res, error.name === 'AbortError' ? 504 : 502,
                error.name === 'AbortError' ? 'Genesys authentication request timed out' : 'Genesys authentication request failed');
        } finally {
            clearTimeout(timeout);
        }
    });

    app.all('/api/proxy/*', async (req, res) => {
        if (req.method !== 'GET' && !checkOrigin(req, res)) return;
        if (req.originalUrl.includes('?')) return sendError(res, 400, 'Query parameters are not supported');

        const apiPath = req.params[0];
        const route = matchProxyRoute(req.method, apiPath);
        if (!route) return sendError(res, 404, 'Proxy route is not allowed');

        const region = req.get('x-gc-region');
        if (!REGIONS.has(region)) return sendError(res, 400, 'Unsupported Genesys Cloud region');
        const authorization = req.get('authorization');
        if (!isBoundedString(authorization, 8, 8192) || !/^Bearer\s+\S+$/i.test(authorization)) {
            return sendError(res, 401, 'A valid bearer token is required');
        }
        if (route.validateBody && !route.validateBody(req.body)) {
            return sendError(res, 400, 'Invalid wrap-up payload');
        }
        if (route.bodyRequired && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
            return sendError(res, 400, 'A JSON object body is required');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const options = {
                method: req.method,
                redirect: 'error',
                signal: controller.signal,
                headers: { Authorization: authorization, Accept: 'application/json' }
            };
            if (req.method !== 'GET') {
                options.headers['Content-Type'] = 'application/json';
                if (req.body !== undefined) options.body = JSON.stringify(req.body);
            }
            const response = await fetchImpl(`https://api.${region}/${apiPath}`, options);
            const payload = await readPayload(response);
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) res.set('Retry-After', retryAfter);
            if (response.status === 204 || payload === null || payload === '') return res.status(response.status).end();
            if (typeof payload === 'object') return res.status(response.status).json(payload);
            return res.status(response.status).type('text/plain').send(payload);
        } catch (error) {
            return sendError(res, error.name === 'AbortError' ? 504 : 502,
                error.name === 'AbortError' ? 'Genesys API request timed out' : 'Genesys API request failed');
        } finally {
            clearTimeout(timeout);
        }
    });

    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error.type === 'entity.too.large') return sendError(res, 413, 'Request body exceeds 16 KB');
        if (error instanceof SyntaxError && error.status === 400) return sendError(res, 400, 'Malformed JSON request body');
        return sendError(res, 500, 'Request failed');
    });

    return app;
}

function isBoundedString(value, min, max) {
    return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}

function checkOrigin(req, res) {
    const origin = req.get('origin');
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === req.get('host').toLowerCase()) return true;
    } catch (_) { /* malformed Origin */ }
    sendError(res, 403, 'Cross-origin mutation requests are not allowed');
    return false;
}

function hostnameFromAuthority(authority) {
    if (typeof authority !== 'string' || !authority.trim()) return null;
    try {
        let value = authority.trim();
        if (value.includes(':') && !value.startsWith('[') && value.split(':').length > 2) value = `[${value}]`;
        return new URL(`http://${value}`).hostname.toLowerCase();
    } catch (_) { return null; }
}

function matchProxyRoute(method, apiPath) {
    if (method === 'POST' && apiPath === 'api/v2/analytics/conversations/details/query') {
        return { bodyRequired: true };
    }
    const conversation = new RegExp(`^api/v2/conversations/(${UUID})$`, 'i').exec(apiPath);
    if (conversation && method === 'GET') return {};

    const disconnect = new RegExp(`^api/v2/conversations/(${UUID})/disconnect$`, 'i').exec(apiPath);
    if (disconnect && method === 'POST') return {};

    const participant = new RegExp(`^api/v2/conversations/(${UUID})/participants/(${UUID})$`, 'i').exec(apiPath);
    if (participant && method === 'PATCH') return { bodyRequired: true, validateBody: isWrapupPayload };
    return null;
}

function isWrapupPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (Object.keys(body).length !== 1 || !body.wrapup || typeof body.wrapup !== 'object' || Array.isArray(body.wrapup)) return false;
    const wrapup = body.wrapup;
    if (Object.keys(wrapup).some(key => !['code', 'notes', 'durationSeconds'].includes(key))) return false;
    if (typeof wrapup.code !== 'string' || !UUID_RE.test(wrapup.code)) return false;
    if (wrapup.notes !== undefined && (typeof wrapup.notes !== 'string' || wrapup.notes.length > 1000)) return false;
    if (wrapup.durationSeconds !== undefined && (!Number.isInteger(wrapup.durationSeconds) || wrapup.durationSeconds < 0 || wrapup.durationSeconds > 3600)) return false;
    return true;
}

async function readPayload(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try { return JSON.parse(text); } catch (_) { return text; }
    }
    return text;
}

function sendError(res, status, message, retryAfter) {
    if (retryAfter) res.set('Retry-After', retryAfter);
    return res.status(status).json({ error: message });
}

if (require.main === module) {
    const app = createApp();
    app.listen(PORT, HOST, () => {
        console.log(`Genesys Cloud helper listening at http://${HOST}:${PORT}`);
    });
}

module.exports = { createApp };
