/** Local Genesys Cloud recovery tool. Preview is always the default. */
const state = {
    accessToken: null, tokenExpiry: 0, baseUrl: null, csvData: [], isProcessing: false,
    stopRequested: false, previewRunning: true, logs: [], fileGeneration: 0,
    stats: { processed: 0, found: 0, accepted: 0, disconnected: 0, pending: 0, errors: 0, wrapupErrors: 0 },
    demo: new URLSearchParams(window.location.search).get('demo') === '1'
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const $ = id => document.getElementById(id);
const DEMO_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

document.addEventListener('DOMContentLoaded', async () => {
    // Remove the old version's plaintext saved secret, never restore it.
    try { localStorage.removeItem('gc_credentials'); } catch { /* Storage may be disabled. */ }
    setupFileUpload();
    if (state.demo) {
        $('demoNotice').classList.remove('hidden');
        $('clientId').value = 'Demo only — no credentials';
        for (const id of ['clientId', 'clientSecret', 'region', 'connectBtn']) $(id).disabled = true;
        $('previewOnly').checked = true;
        $('previewOnly').disabled = true;
        $('authStatus').querySelector('.status-text').textContent = 'Demo preview';
        $('searchType').value = 'conversationid';
        showSections();
        parseCSV('conversationId\n' + DEMO_IDS.join('\n'), 'demo-conversations.csv');
        return;
    }
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('Could not load server configuration.');
        const config = await response.json();
        $('clientId').value = config.clientId || '';
        $('region').value = config.region;
        $('clientSecret').placeholder = config.hasSecret ? 'Leave blank to use this server’s configured secret' : 'Enter OAuth Client Secret';
    } catch (error) { showToast('error', 'Server unavailable', error.message); }
});

function setupFileUpload() {
    const zone = $('uploadZone');
    zone.addEventListener('click', () => { if (!state.isProcessing) $('csvFile').click(); });
    zone.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); zone.click(); }
    });
    zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', event => {
        event.preventDefault(); zone.classList.remove('drag-over');
        if (!state.isProcessing && event.dataTransfer.files[0]) handleFileSelect(event.dataTransfer.files[0]);
    });
    $('csvFile').addEventListener('change', event => { if (event.target.files[0]) handleFileSelect(event.target.files[0]); });
}

function clearFile() {
    state.csvData = [];
    $('fileInfo').classList.add('hidden');
    $('uploadZone').classList.remove('has-file');
    updateActionButton();
}
function handleFileSelect(file) {
    if (state.isProcessing) return;
    clearFile();
    if (!/\.csv$/i.test(file.name) || file.size > 1048576) {
        showToast('error', 'Invalid file', 'Choose a CSV file no larger than 1 MiB.');
        return;
    }
    const generation = ++state.fileGeneration;
    const reader = new FileReader();
    reader.onload = event => { if (generation === state.fileGeneration) parseCSV(event.target.result, file.name); };
    reader.onerror = () => { clearFile(); showToast('error', 'File error', 'The CSV could not be read.'); };
    reader.readAsText(file);
}
function parseCSV(content, fileName) {
    clearFile();
    try {
        const result = CSVUtils.parseIdentifiers(content);
        if (!result.identifiers.length) throw new Error('No identifiers found in the first column.');
        state.csvData = result.identifiers;
        $('fileName').textContent = fileName;
        $('fileRecords').textContent = `${state.csvData.length} unique records · ${result.duplicatesRemoved} duplicates removed`;
        $('fileInfo').classList.remove('hidden');
        $('uploadZone').classList.add('has-file');
        updateActionButton();
    } catch (error) { showToast('error', 'Invalid CSV', error.message); }
}

async function authenticate() {
    if (state.demo || state.isProcessing) return;
    const clientId = $('clientId').value.trim();
    if (!clientId) { showToast('error', 'Client ID required', 'Configure or enter an OAuth client ID.'); return; }
    const region = $('region').value;
    $('connectBtn').disabled = true;
    state.accessToken = null;
    updateAuthStatus(false);
    updateActionButton();
    try {
        const response = await fetch('/api/auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, clientSecret: $('clientSecret').value.trim(), region }),
            signal: AbortSignal.timeout(20000)
        });
        await requireOk(response, 'Authentication');
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !(Number(data.expires_in) > 0)) throw new Error('Invalid authentication response.');
        state.accessToken = data.access_token;
        state.tokenExpiry = Date.now() + Number(data.expires_in) * 1000;
        state.baseUrl = region;
        updateAuthStatus(true);
        showSections();
        showToast('success', 'Connected', 'Token is held only in this tab. Preview before making changes.');
    } catch (error) { showToast('error', 'Connection failed', error.message); }
    finally { $('clientSecret').value = ''; $('connectBtn').disabled = false; }
}
function updateAuthStatus(connected) {
    $('authStatus').classList.toggle('connected', connected);
    $('authStatus').querySelector('.status-text').textContent = connected ? 'Connected' : 'Not connected';
}
function showSections() {
    $('uploadSection').classList.remove('hidden');
    $('wrapupSection').classList.remove('hidden');
    updateActionButton();
}
function updateActionButton() {
    $('actionSection').classList.toggle('hidden', !state.csvData.length || (!state.accessToken && !state.demo));
    $('processLabel').textContent = $('previewOnly').checked ? 'Preview conversations' : 'Review and disconnect';
    $('processBtn').classList.toggle('btn-danger', !$('previewOnly').checked);
    $('processBtn').classList.toggle('btn-primary', $('previewOnly').checked);
}
function stopProcessing() {
    state.stopRequested = true;
    $('stopBtn').disabled = true;
    addLog('warning', 'Stop requested. The current request may still finish; completed changes cannot be undone.');
}
function setProcessing(active) {
    state.isProcessing = active;
    for (const id of ['clientId', 'clientSecret', 'region', 'connectBtn', 'csvFile', 'searchType', 'monthsBack', 'wrapUpCode', 'wrapUpNotes', 'wrapUpDuration', 'previewOnly', 'processBtn']) {
        $(id).disabled = active || (state.demo && ['clientId', 'clientSecret', 'region', 'connectBtn', 'previewOnly'].includes(id));
    }
    $('stopBtn').classList.toggle('hidden', !active);
    $('stopBtn').disabled = !active;
}
function settings() {
    if (!state.csvData.length) throw new Error('Import identifiers first.');
    const searchType = $('searchType').value;
    if (!['caseid', 'conversationid'].includes(searchType)) throw new Error('Invalid search type.');
    const months = Number($('monthsBack').value);
    if (!Number.isInteger(months) || months < 1 || months > 18) throw new Error('Search windows must be between 1 and 18.');
    const code = $('wrapUpCode').value.trim();
    const notes = $('wrapUpNotes').value;
    const duration = Number($('wrapUpDuration').value);
    if (code && !UUID.test(code)) throw new Error('The optional wrap-up code must be a code UUID, not its name.');
    if (notes.length > 1000 || !Number.isInteger(duration) || duration < 0 || duration > 3600) throw new Error('Notes must be at most 1,000 characters and duration 0–3,600 seconds.');
    const identifiers = state.csvData.map(id => searchType === 'conversationid' ? id.toLowerCase() : id);
    for (const id of identifiers) {
        if (searchType === 'conversationid' && !UUID.test(id)) throw new Error('Invalid conversation UUID: ' + id);
        if (searchType === 'caseid' && id.length > 36) throw new Error('External tags cannot exceed 36 characters.');
    }
    return { identifiers, searchType, months, code, notes, duration, preview: $('previewOnly').checked };
}

async function processDisconnect() {
    if (state.isProcessing) return;
    let config;
    try { config = settings(); }
    catch (error) { showToast('error', 'Check settings', error.message); return; }
    if (state.demo && !config.preview) { showToast('error', 'Demo only', 'Live operations are disabled in demo mode.'); return; }
    state.previewRunning = true;
    state.stopRequested = false;
    state.stats = { processed: 0, found: 0, accepted: 0, disconnected: 0, pending: 0, errors: 0, wrapupErrors: 0 };
    state.logs = [];
    $('logContainer').replaceChildren();
    $('progressSection').classList.remove('hidden');
    $('logSection').classList.remove('hidden');
    setProcessing(true);
    updateStats();
    try {
        addLog('info', `Resolving ${config.identifiers.length} input records. No changes have been sent.`);
        const targets = new Set();
        for (const id of config.identifiers) {
            if (state.stopRequested) break;
            const found = config.searchType === 'conversationid' ? [id] : await findConversations(id, config.searchType, config.months);
            if (!found.length) addLog('info', 'No indexed active matches for ' + id);
            found.forEach(target => targets.add(target.toLowerCase()));
            if (targets.size > 1000) throw new Error('More than 1,000 targets matched. Use a smaller input or search range.');
        }
        state.stats.found = targets.size;
        const candidates = [];
        for (const id of targets) {
            if (state.stopRequested) break;
            const details = await conversationDetails(id);
            state.stats.processed++;
            if (conversationEnded(details)) addLog('info', 'Already ended; skipped: ' + id);
            else {
                candidates.push({ id, agentIds: (details.participants || []).filter(participant => participant.purpose === 'agent' && !conversationEnded({ participants: [participant] })).map(participant => participant.id) });
                addLog('info', `PREVIEW ${id}: ${details.participants?.length || 0} participants; teardown candidate.`);
            }
            updateProgress(state.stats.processed, targets.size);
            updateStats();
        }
        if (state.stopRequested) { addLog('warning', 'Stopped during discovery. No changes were sent.'); return; }
        addLog('info', `Preview complete: ${candidates.length} unique teardown candidates in ${state.baseUrl || 'demo data'}.`);
        if (config.preview || !candidates.length) {
            showToast('info', 'Preview complete', `${candidates.length} candidates. No disconnect or wrap-up requests sent.`);
            return;
        }
        const scope = `${candidates.length} conversations in ${state.baseUrl}`;
        if (!window.confirm(`Perform full teardown of ${scope}?\n\nThis can end live interactions and assign system wrap-up codes. It cannot be undone.\n\nContinue only if you reviewed the preview log.`)) {
            addLog('info', 'Cancelled before sending any changes.'); return;
        }
        state.previewRunning = false;
        for (const target of candidates) {
            if (state.stopRequested) break;
            const id = target.id;
            try { await disconnectConversation(id, config.code, config.notes, config.duration, target.agentIds); }
            catch (error) {
                state.stats.errors++;
                addLog('error', `${id}: ${error.message} The request may have reached Genesys Cloud; check current state before retrying.`);
            }
            updateStats();
        }
        addLog('info', `Batch finished: ${state.stats.accepted} accepted, ${state.stats.disconnected} verified ended, ${state.stats.pending} unverified, ${state.stats.errors} errors, ${state.stats.wrapupErrors} wrap-up issues.`);
        showToast(state.stats.errors || state.stats.pending || state.stats.wrapupErrors || state.stopRequested ? 'warning' : 'success',
            state.stopRequested ? 'Stopped' : 'Batch finished', `${state.stats.disconnected} verified ended; review the log for accepted, unverified and failed steps.`);
    } catch (error) {
        state.stats.errors++;
        addLog('error', 'Discovery failed: ' + error.message + ' No disconnect or wrap-up requests were sent.');
        showToast('error', 'Preview incomplete', 'Resolve discovery errors before attempting live changes.');
    } finally {
        state.previewRunning = true;
        setProcessing(false);
        updateStats();
        updateActionButton();
    }
}

async function findConversations(attribute, searchType, monthsBack) {
    const found = new Set();
    const now = Date.now();
    const windowMs = 30 * 86400000;
    for (let interval = 0; interval < monthsBack && !state.stopRequested; interval++) {
        let page = 1;
        let windowCount = 0;
        while (!state.stopRequested) {
            const query = {
                interval: `${new Date(now - (interval + 1) * windowMs).toISOString()}/${new Date(now - interval * windowMs).toISOString()}`,
                order: 'asc', orderBy: 'conversationStart', paging: { pageSize: 100, pageNumber: page },
                conversationFilters: [{ type: 'and', predicates: [
                    { dimension: 'externalTag', operator: 'matches', value: attribute },
                    { dimension: 'conversationEnd', operator: 'notExists' }
                ] }]
            };
            const response = await apiRequest('POST', '/api/v2/analytics/conversations/details/query', query);
            await requireOk(response, 'Analytics search');
            const data = await response.json();
            const conversations = data.conversations || [];
            for (const item of conversations) {
                if (!UUID.test(item.conversationId || '')) throw new Error('Analytics returned an invalid conversation ID.');
                found.add(item.conversationId);
            }
            if (found.size > 1000) throw new Error('Too many matches. Narrow the input or search range.');
            windowCount += conversations.length;
            if (conversations.length < 100 || (Number.isFinite(data.totalHits) && windowCount >= data.totalHits)) break;
            if (++page > 100) throw new Error('Search exceeds 10,000 results in one interval. Narrow the range.');
        }
    }
    return [...found];
}

function conversationEnded(data) {
    const terminal = item => ['disconnected', 'terminated'].includes(String(item.state || '').toLowerCase()) ||
        [item.endTime, item.disconnectedTime].some(value => value && Number.isFinite(Date.parse(value)));
    return Array.isArray(data.participants) && data.participants.length > 0 && data.participants.every(participant => {
        if (terminal(participant)) return true;
        const media = ['calls', 'callbacks', 'chats', 'emails', 'messages', 'videos'].flatMap(key => Array.isArray(participant[key]) ? participant[key] : []);
        return media.length > 0 && media.every(terminal);
    });
}
async function conversationDetails(id) {
    if (!UUID.test(id)) throw new Error('Invalid conversation UUID.');
    const response = await apiRequest('GET', `/api/v2/conversations/${id}`);
    await requireOk(response, 'Conversation lookup');
    return response.json();
}
async function disconnectConversation(id, code, notes, duration, eligibleAgentIds = null) {
    // Never repeat a teardown/PATCH automatically after failure or timeout.
    const response = await apiRequest('POST', `/api/v2/conversations/${id}/disconnect`);
    await requireOk(response, 'Disconnect');
    state.stats.accepted++;
    addLog('info', 'Disconnect request accepted: ' + id);
    let details;
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            details = await conversationDetails(id);
            if (conversationEnded(details) || state.stopRequested) break;
            await sleep(300);
        }
        if (conversationEnded(details)) {
            state.stats.disconnected++;
            addLog('success', 'Read-back shows all returned participants ended: ' + id);
        } else {
            state.stats.pending++;
            addLog('warning', 'Disconnect accepted, but read-back has not confirmed every participant ended: ' + id);
        }
    } catch (error) {
        state.stats.pending++;
        addLog('warning', 'Disconnect accepted; read-back failed: ' + error.message);
    }
    if (!code || state.stopRequested) return;
    const agents = details?.participants?.filter(participant => participant.purpose === 'agent' &&
        (eligibleAgentIds === null || eligibleAgentIds.includes(participant.id))) || [];
    if (!agents.length) {
        state.stats.wrapupErrors++;
        addLog('warning', 'Custom wrap-up skipped: no eligible agent participant from the preview for ' + id);
        return;
    }
    for (const agent of agents) {
        if (state.stopRequested) break;
        try {
            const result = await apiRequest('PATCH', `/api/v2/conversations/${id}/participants/${agent.id}`, {
                wrapup: { code, notes, durationSeconds: duration }
            });
            await requireOk(result, 'Custom wrap-up');
            const updated = await conversationDetails(id);
            const readback = updated.participants?.find(participant => participant.id === agent.id);
            if (readback?.wrapup?.code !== code) throw new Error('Requested code not confirmed in participant read-back.');
            addLog('success', 'Custom wrap-up code verified for agent participant ' + agent.id);
        } catch (error) {
            state.stats.wrapupErrors++;
            addLog('warning', 'Disconnect remains accepted; custom wrap-up issue: ' + error.message);
        }
    }
}

async function apiRequest(method, endpoint, body = null) {
    const mutation = method !== 'GET' && endpoint !== '/api/v2/analytics/conversations/details/query';
    if (mutation && (state.previewRunning || state.demo)) throw new Error('Changes are blocked in preview or demo mode.');
    if (state.demo) {
        if (method === 'GET' && /^\/api\/v2\/conversations\/[a-f0-9-]+$/.test(endpoint)) {
            return new Response(JSON.stringify({ participants: [{ id: DEMO_IDS[0], purpose: 'agent', state: 'connected' }, { id: DEMO_IDS[1], purpose: 'customer', state: 'connected' }] }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (endpoint === '/api/v2/analytics/conversations/details/query') return new Response(JSON.stringify({ conversations: DEMO_IDS.map(conversationId => ({ conversationId })), totalHits: 2 }));
        throw new Error('No live APIs are available in demo mode.');
    }
    if (!state.accessToken || Date.now() >= state.tokenExpiry) {
        state.accessToken = null; updateAuthStatus(false); updateActionButton();
        throw new Error('Session expired. Connect again.');
    }
    const options = { method, headers: { Authorization: `Bearer ${state.accessToken}`, 'Content-Type': 'application/json', 'x-gc-region': state.baseUrl }, signal: AbortSignal.timeout(20000) };
    if (body !== null) options.body = JSON.stringify(body);
    let response;
    const readOnly = method === 'GET' || endpoint === '/api/v2/analytics/conversations/details/query';
    for (let attempt = 0; attempt < (readOnly ? 3 : 1); attempt++) {
        response = await fetch('/api/proxy' + endpoint, { ...options, signal: AbortSignal.timeout(20000) });
        if (response.status !== 429 || attempt === 2 || !readOnly || state.stopRequested) break;
        const value = response.headers.get('retry-after');
        const seconds = value === null ? NaN : Number(value);
        const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Date.parse(value) - Date.now();
        if (Number.isFinite(delay) && delay > 60000) throw new Error('Genesys rate limit requires a wait longer than one minute. Retry later.');
        await sleep(Number.isFinite(delay) ? Math.max(1000, delay) : 3000 * (attempt + 1));
    }
    if (response.status === 401) { state.accessToken = null; updateAuthStatus(false); }
    return response;
}
async function requireOk(response, action) {
    if (response.ok) return;
    let detail = '';
    try { const data = await response.json(); detail = typeof data.error === 'string' ? data.error : ''; } catch { /* Empty error body. */ }
    throw new Error(`${action} failed (${response.status})${detail ? ': ' + detail : ''}`);
}
function updateProgress(current, total) {
    $('progressFill').style.width = `${total ? Math.round(current / total * 100) : 0}%`;
    $('progressText').textContent = `Reviewed ${current} of ${total} unique targets`;
}
function updateStats() {
    for (const [field, id] of [['processed', 'statProcessed'], ['found', 'statFound'], ['accepted', 'statAccepted'], ['disconnected', 'statDisconnected'], ['pending', 'statPending'], ['errors', 'statErrors']]) $(id).textContent = state.stats[field];
}
function addLog(type, message) {
    const time = new Date().toLocaleTimeString();
    state.logs.push({ time, type, message });
    const div = document.createElement('div');
    div.className = 'log-entry ' + type;
    const timestamp = document.createElement('span'); timestamp.className = 'log-time'; timestamp.textContent = '[' + time + ']';
    const text = document.createElement('span'); text.className = 'log-message'; text.textContent = message;
    div.append(timestamp, text);
    $('logContainer').appendChild(div);
    $('logContainer').scrollTop = $('logContainer').scrollHeight;
}
function togglePassword(id) { $(id).type = $(id).type === 'password' ? 'text' : 'password'; }
function showToast(type, title, message) {
    const toast = document.createElement('div'); toast.className = 'toast ' + type;
    const content = document.createElement('div'); content.className = 'toast-content';
    for (const [className, value] of [['toast-title', title], ['toast-message', message]]) {
        const element = document.createElement('div'); element.className = className; element.textContent = value; content.appendChild(element);
    }
    const close = document.createElement('button'); close.className = 'toast-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss notification'); close.onclick = () => toast.remove();
    toast.append(content, close); $('toastContainer').appendChild(toast);
    setTimeout(() => toast.remove(), 7000);
}
function exportLog() {
    if (!state.logs.length) return;
    const content = state.logs.map(entry => `[${entry.time}] [${entry.type.toUpperCase()}] ${entry.message}`).join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'disconnect-log-' + new Date().toISOString().slice(0, 10) + '.txt'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
