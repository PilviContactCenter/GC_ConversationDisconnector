const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');

const REGION = 'mypurecloud.de';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT = '22222222-2222-4222-8222-222222222222';
const CODE = '33333333-3333-4333-8333-333333333333';

async function withServer(options, run) {
    const server = createApp(options).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function json(response) {
    return response.json();
}

test('serves only explicit assets and reports health/config without secret', async () => {
    await withServer({ env: { GENESYS_CLOUD_CLIENT_ID: 'public-id', GENESYS_CLOUD_CLIENT_SECRET: 'private-secret', GENESYS_CLOUD_REGION: REGION } }, async base => {
        const configResponse = await fetch(`${base}/api/config`);
        assert.equal(configResponse.headers.get('cache-control'), 'no-store');
        assert.equal(configResponse.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(configResponse.headers.get('referrer-policy'), 'no-referrer');
        assert.deepEqual(await json(configResponse), { clientId: 'public-id', region: REGION, hasSecret: true });
        assert.equal((await fetch(`${base}/api/health`)).status, 200);
        for (const resource of ['/server.js', '/package.json', '/.env.example', '/README.md']) {
            assert.equal((await fetch(`${base}${resource}`)).status, 404, resource);
        }
        assert.equal((await fetch(`${base}/app.js`)).status, 200);
    });
});

test('rejects a DNS-rebinding Host header before serving or making upstream calls', async () => {
    let calls = 0;
    await withServer({ fetchImpl: async () => { calls++; throw new Error('unexpected network call'); } }, async base => {
        const response = await new Promise((resolve, reject) => {
            http.get(`${base}/api/health`, { headers: { Host: 'attacker.example' } }, resolve).on('error', reject);
        });
        assert.equal(response.statusCode, 403);
        const body = await new Promise((resolve, reject) => {
            let value = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { value += chunk; });
            response.on('end', () => resolve(JSON.parse(value)));
            response.on('error', reject);
        });
        assert.deepEqual(body, { error: 'Host is not allowed' });
        assert.equal(calls, 0);
    });
});

test('uses env secret only for matching client id and region; never returns it', async () => {
    const calls = [];
    await withServer({
        env: { GENESYS_CLOUD_CLIENT_ID: 'env-id', GENESYS_CLOUD_CLIENT_SECRET: 'env-secret', GENESYS_CLOUD_REGION: REGION },
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600, token_type: 'bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    }, async base => {
        const response = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'env-id', region: REGION })
        });
        assert.equal(response.status, 200);
        const result = await json(response);
        assert.deepEqual(result, { access_token: 'test-token', expires_in: 3600 });
        assert.equal(JSON.stringify(result).includes('env-secret'), false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('env-id:env-secret').toString('base64')}`);

        const mismatch = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'other-id', region: REGION })
        });
        assert.equal(mismatch.status, 400);
        assert.equal(calls.length, 1);
    });
});

test('rejects unsupported configured region at startup and accepts the FedRAMP region', async () => {
    assert.throws(() => createApp({ env: { GENESYS_CLOUD_REGION: 'use2.pure.cloud' } }), /Unsupported GENESYS_CLOUD_REGION/);
    await withServer({ env: { GENESYS_CLOUD_REGION: 'use2.us-gov-pure.cloud' } }, async base => {
        const response = await fetch(`${base}/api/config`);
        assert.deepEqual(await json(response), { clientId: '', region: 'use2.us-gov-pure.cloud', hasSecret: false });
    });
});

test('rejects invalid region, bearer token, and proxy path before network access', async () => {
    let calls = 0;
    await withServer({ fetchImpl: async () => { calls++; throw new Error('unexpected network call'); } }, async base => {
        const auth = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'id', clientSecret: 'secret', region: 'evil.example' })
        });
        assert.equal(auth.status, 400);
        const invalidRoute = await fetch(`${base}/api/proxy/api/v2/users/me`, {
            headers: { authorization: 'Bearer token', 'x-gc-region': REGION }
        });
        assert.equal(invalidRoute.status, 404);
        const invalidBearer = await fetch(`${base}/api/proxy/api/v2/conversations/${CONVERSATION}`, {
            headers: { authorization: 'Basic token', 'x-gc-region': REGION }
        });
        assert.equal(invalidBearer.status, 401);
        const queryVariant = await fetch(`${base}/api/proxy/api/v2/conversations/${CONVERSATION}?expand=participants`, {
            headers: { authorization: 'Bearer token', 'x-gc-region': REGION }
        });
        assert.equal(queryVariant.status, 400);
        const badRegion = await fetch(`${base}/api/proxy/api/v2/conversations/${CONVERSATION}`, {
            headers: { authorization: 'Bearer token', 'x-gc-region': 'evil.example' }
        });
        assert.equal(badRegion.status, 400);
        assert.equal(calls, 0);
    });
});

test('validates wrap-up payload before proxying and handles 204 response', async () => {
    const calls = [];
    await withServer({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 204 });
    } }, async base => {
        const endpoint = `${base}/api/proxy/api/v2/conversations/${CONVERSATION}/participants/${PARTICIPANT}`;
        const headers = { authorization: 'Bearer token', 'x-gc-region': REGION, 'content-type': 'application/json' };
        const bad = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify({ wrapup: { code: 'name', notes: 'ok' } }) });
        assert.equal(bad.status, 400);
        assert.equal(calls.length, 0);
        const ok = await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify({ wrapup: { code: CODE, notes: 'done', durationSeconds: 0 } }) });
        assert.equal(ok.status, 204);
        assert.equal(await ok.text(), '');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.redirect, 'error');
    });
});

test('preserves 429 status and Retry-After from Genesys', async () => {
    await withServer({ fetchImpl: async () => new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' }
    }) }, async base => {
        const response = await fetch(`${base}/api/proxy/api/v2/conversations/${CONVERSATION}`, {
            headers: { authorization: 'Bearer token', 'x-gc-region': REGION }
        });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '2');
        assert.deepEqual(await json(response), { message: 'rate limited' });
    });
});

test('rejects cross-origin mutation requests but allows requests without Origin', async () => {
    let calls = 0;
    await withServer({ fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify({ access_token: 'ok', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    } }, async base => {
        const crossOrigin = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'id', clientSecret: 'secret', region: REGION })
        });
        assert.equal(crossOrigin.status, 403);
        const noOrigin = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'id', clientSecret: 'secret', region: REGION })
        });
        assert.equal(noOrigin.status, 200);
        assert.equal(calls, 1);
        assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
    });
});

test('rejects authentication responses without a positive finite expiry', async () => {
    await withServer({ fetchImpl: async () => new Response(JSON.stringify({ access_token: 'token', expires_in: '3600' }), {
        status: 200, headers: { 'content-type': 'application/json' }
    }) }, async base => {
        const response = await fetch(`${base}/api/auth`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: 'id', clientSecret: 'secret', region: REGION })
        });
        assert.equal(response.status, 502);
        assert.deepEqual(await json(response), { error: 'Genesys returned an invalid authentication response' });
    });
});
