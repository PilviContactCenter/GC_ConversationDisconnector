const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '44444444-4444-4444-8444-444444444444';
const WRAPUP = '33333333-3333-4333-8333-333333333333';

function response(status, data = {}, headers = {}) {
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...headers }
    });
}

async function browser({ demo = false, fetchImpl } = {}) {
    const calls = [];
    const dom = new JSDOM(HTML, {
        runScripts: 'outside-only',
        url: `http://127.0.0.1/${demo ? '?demo=1' : ''}`
    });
    const { window } = dom;
    window.Response = Response;
    window.AbortSignal = AbortSignal;
    window.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
        return fetchImpl ? fetchImpl(String(url), options, calls.length) : response(200, {
            clientId: 'test-client', region: 'mypurecloud.de', hasSecret: false
        });
    };
    window.confirm = () => true;
    window.sleep = async () => {};
    const context = dom.getInternalVMContext();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'csv-utils.js'), 'utf8'), context, { filename: 'csv-utils.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), context, { filename: 'app.js' });

    if (window.document.readyState === 'loading') {
        await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    } else {
        window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    return {
        dom, window, calls,
        eval(code) { return vm.runInContext(code, context); },
        setLive() {
            vm.runInContext(`state.accessToken = 'mock-token'; state.tokenExpiry = Date.now() + 60000; state.baseUrl = 'mypurecloud.de'; state.previewRunning = false;`, context);
        },
        close() { dom.window.close(); }
    };
}

function proxyCalls(calls) {
    return calls.filter(call => call.url.startsWith('/api/proxy/'));
}

test('preview is selected by default and demo mode performs no network requests or mutations', async t => {
    const live = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'GET') return response(200, { participants: [{ id: UUID_B, purpose: 'customer', state: 'connected' }] });
        throw new Error('Preview attempted a write: ' + options.method);
    } });
    t.after(() => live.close());
    live.setLive();
    assert.equal(live.window.document.getElementById('previewOnly').checked, true);
    live.eval(`parseCSV('conversationId\\n${UUID_A}', 'ids.csv'); $('searchType').value = 'conversationid';`);
    await live.eval('processDisconnect()');
    assert.equal(proxyCalls(live.calls).filter(call => call.method === 'GET').length, 1);
    assert.equal(proxyCalls(live.calls).some(call => call.method !== 'GET'), false);
    assert.equal(live.eval('state.stats.found'), 1);

    const demo = await browser({ demo: true });
    t.after(() => demo.close());
    assert.equal(demo.window.document.getElementById('previewOnly').checked, true);
    assert.equal(demo.calls.length, 0);
    await demo.eval('processDisconnect()');
    assert.equal(demo.calls.length, 0);
    assert.equal(demo.eval('state.stats.disconnected'), 0);
});

test('invalid CSV clears previously loaded identifiers', async t => {
    const app = await browser();
    t.after(() => app.close());
    app.eval(`parseCSV('conversationId\\n${UUID_A}', 'valid.csv');`);
    assert.deepEqual(Array.from(app.eval('state.csvData')), [UUID_A]);
    app.eval(`parseCSV('conversationId\\n"unterminated', 'invalid.csv');`);
    assert.deepEqual(Array.from(app.eval('state.csvData')), []);
    assert.equal(app.window.document.getElementById('fileInfo').classList.contains('hidden'), true);
});

test('CSV and log content are rendered as literal text, not HTML', async t => {
    const app = await browser();
    t.after(() => app.close());
    const payload = '<img src=x onerror=alert(1)>';
    app.eval(`parseCSV(${JSON.stringify(`caseId\n${payload}`)}, ${JSON.stringify(payload)});`);
    assert.equal(app.window.document.querySelector('#fileName img'), null);
    assert.equal(app.window.document.querySelector('#fileName').textContent, payload);
    app.eval(`addLog('info', ${JSON.stringify(payload)});`);
    assert.equal(app.window.document.querySelector('#logContainer img'), null);
    assert.equal(app.window.document.querySelector('#logContainer').textContent.includes(payload), true);
});

test('invalid conversation UUID stops before any Genesys API request', async t => {
    const app = await browser();
    t.after(() => app.close());
    app.setLive();
    app.eval(`parseCSV('not-a-uuid', 'ids.csv'); $('searchType').value = 'conversationid';`);
    await app.eval('processDisconnect()');
    assert.deepEqual(proxyCalls(app.calls), []);
});

test('analytics HTTP errors reject the search instead of appearing as no matches', async t => {
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        return response(403, { error: 'Forbidden' });
    } });
    t.after(() => app.close());
    app.setLive();
    await assert.rejects(app.eval(`findConversations('case-1', 'caseid', 1)`), /Analytics search failed \(403\)/);
});

test('analytics query paginates each interval independently and deduplicates overlap between windows', async t => {
    const queries = [];
    const pages = [
        Array.from({ length: 100 }, (_, index) => ({ conversationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })),
        Array.from({ length: 100 }, (_, index) => ({ conversationId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}` }))
    ];
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (url.endsWith('/analytics/conversations/details/query')) {
            const query = JSON.parse(options.body);
            queries.push(query);
            return response(200, { conversations: pages[query.paging.pageNumber - 1], totalHits: 200 });
        }
        throw new Error('Unexpected request: ' + url);
    } });
    t.after(() => app.close());
    app.setLive();
    const found = Array.from(await app.eval(`findConversations('case-1', 'caseid', 2)`));
    assert.equal(queries.length, 4);
    assert.equal(queries.every(query => query.paging.pageSize === 100), true);
    assert.deepEqual(queries.map(query => query.paging.pageNumber), [1, 2, 1, 2]);
    assert.equal(new Set(queries.map(query => query.interval)).size, 2);
    assert.equal(found.length, 200);
});

test('a conversation is ended only when there is at least one participant and all participant/media states are terminal', async t => {
    const app = await browser();
    t.after(() => app.close());
    assert.equal(app.eval('conversationEnded({ participants: [] })'), false);
    assert.equal(app.eval(`conversationEnded({ participants: [{state:'disconnected'}, {state:'connected'}] })`), false);
    assert.equal(app.eval(`conversationEnded({ participants: [{calls:[{state:'disconnected'}]}, {chats:[{state:'terminated'}]}] })`), true);
    assert.equal(app.eval(`conversationEnded({ participants: [{calls:[{state:'disconnected'}, {state:'connected'}]}] })`), false);
});

test('disconnect acceptance followed by failed read-back is counted as accepted and pending, not verified', async t => {
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'POST') return response(200, 'accepted');
        if (options.method === 'GET') return response(503, { error: 'Unavailable' });
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => app.close());
    app.setLive();
    await app.eval(`disconnectConversation('${UUID_A}', '', '', 0)`);
    assert.equal(app.eval('state.stats.accepted'), 1);
    assert.equal(app.eval('state.stats.pending'), 1);
    assert.equal(app.eval('state.stats.disconnected'), 0);
});

test('wrap-up PATCH failure is reported separately and ACD participants are never selected as agents', async t => {
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'POST') return response(200, 'accepted');
        if (options.method === 'GET') return response(200, { participants: [{ id: UUID_B, purpose: 'agent', state: 'disconnected' }] });
        if (options.method === 'PATCH') return response(500, { error: 'Wrap-up rejected' });
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => app.close());
    app.setLive();
    await app.eval(`disconnectConversation('${UUID_A}', '${WRAPUP}', 'notes', 2)`);
    assert.equal(app.eval('state.stats.accepted'), 1);
    assert.equal(app.eval('state.stats.wrapupErrors'), 1);
    assert.equal(app.eval('state.stats.errors'), 0);
    assert.equal(proxyCalls(app.calls).some(call => call.method === 'PATCH'), true);

    const noAgent = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'POST') return response(200, 'accepted');
        if (options.method === 'GET') return response(200, { participants: [{ id: UUID_B, purpose: 'acd', state: 'disconnected' }] });
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => noAgent.close());
    noAgent.setLive();
    await noAgent.eval(`disconnectConversation('${UUID_A}', '${WRAPUP}', '', 2)`);
    assert.equal(noAgent.eval('state.stats.wrapupErrors'), 1);
    assert.equal(proxyCalls(noAgent.calls).some(call => call.method === 'PATCH'), false);
});

test('eligible agent IDs restrict wrap-up PATCH to the reviewed agent', async t => {
    const savedWrapups = new Map();
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'POST') return response(200, 'accepted');
        if (options.method === 'GET') return response(200, { participants: [
            { id: UUID_B, purpose: 'agent', state: 'disconnected', ...(savedWrapups.has(UUID_B) ? { wrapup: { code: savedWrapups.get(UUID_B) } } : {}) },
            { id: UUID_C, purpose: 'agent', state: 'disconnected', ...(savedWrapups.has(UUID_C) ? { wrapup: { code: savedWrapups.get(UUID_C) } } : {}) }
        ] });
        if (options.method === 'PATCH') {
            const id = url.split('/').pop();
            savedWrapups.set(id, JSON.parse(options.body).wrapup.code);
            return response(200, {});
        }
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => app.close());
    app.setLive();
    await app.eval(`disconnectConversation('${UUID_A}', '${WRAPUP}', '', 2, ['${UUID_B}'])`);
    const patches = proxyCalls(app.calls).filter(call => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].url.endsWith(`/participants/${UUID_B}`), true);
    assert.equal(app.eval('state.stats.wrapupErrors'), 0);
});

test('API writes are blocked while preview is active', async t => {
    const app = await browser();
    t.after(() => app.close());
    app.setLive();
    app.eval('state.previewRunning = true');
    await assert.rejects(app.eval(`apiRequest('POST', '/api/v2/conversations/${UUID_A}/disconnect')`), /blocked in preview or demo/);
    assert.deepEqual(proxyCalls(app.calls), []);
});

test('write 429 is never retried automatically', async t => {
    let writes = 0;
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'POST') { writes++; return response(429, { error: 'Rate limited' }, { 'retry-after': '0' }); }
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => app.close());
    app.setLive();
    await assert.rejects(app.eval(`disconnectConversation('${UUID_A}', '', '', 0)`), /Disconnect failed \(429\)/);
    assert.equal(writes, 1);
});

test('cancelling live confirmation prevents disconnect and wrap-up requests', async t => {
    const app = await browser({ fetchImpl: async (url, options) => {
        if (url === '/api/config') return response(200, { clientId: '', region: 'mypurecloud.de', hasSecret: false });
        if (options.method === 'GET') return response(200, { participants: [{ id: UUID_B, purpose: 'customer', state: 'connected' }] });
        throw new Error('Unexpected request: ' + options.method);
    } });
    t.after(() => app.close());
    app.setLive();
    app.window.confirm = () => false;
    app.eval(`parseCSV('conversationId\\n${UUID_A}', 'ids.csv'); $('searchType').value = 'conversationid'; $('previewOnly').checked = false;`);
    await app.eval('processDisconnect()');
    assert.equal(proxyCalls(app.calls).some(call => call.method !== 'GET'), false);
});

test('startup removes legacy saved credentials and does not restore them', async t => {
    const app = await browser();
    t.after(() => app.close());
    app.window.localStorage.setItem('gc_credentials', JSON.stringify({ clientId: 'old-id', clientSecret: 'old-secret', region: 'mypurecloud.com' }));
    app.window.document.dispatchEvent(new app.window.Event('DOMContentLoaded'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.window.localStorage.getItem('gc_credentials'), null);
    assert.equal(app.window.document.getElementById('clientSecret').value, '');
});
