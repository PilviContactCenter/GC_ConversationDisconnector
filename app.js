/**
 * Genesys Cloud Disconnect Tool
 * Modern web application for bulk disconnecting conversations
 */

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    accessToken: null,
    baseUrl: null,
    csvData: [],
    isProcessing: false,
    stats: { processed: 0, found: 0, disconnected: 0, errors: 0 },
    logs: []
};

// ============================================
// DOM ELEMENTS
// ============================================
const $ = (id) => document.getElementById(id);

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Load saved credentials
    loadSavedCredentials();

    // Load server config (if running via server)
    loadServerConfig();

    // Setup file upload
    setupFileUpload();

    // Log startup
    console.log('Genesys Cloud Disconnect Tool initialized');
}

async function loadServerConfig() {
    try {
        const response = await fetch('/api/config');
        if (response.ok) {
            const config = await response.json();
            if (config.clientId && !$('clientId').value) {
                $('clientId').value = config.clientId;
            }
            if (config.region) {
                $('region').value = config.region;
            }
            state.useProxy = true;
            console.log('Server proxy mode enabled');
        }
    } catch (e) {
        // Running without server - direct API mode
        state.useProxy = false;
        console.log('Direct API mode (may have CORS issues)');
    }
}

function loadSavedCredentials() {
    const saved = localStorage.getItem('gc_credentials');
    if (saved) {
        try {
            const creds = JSON.parse(saved);
            $('clientId').value = creds.clientId || '';
            $('clientSecret').value = creds.clientSecret || '';
            $('region').value = creds.region || 'mypurecloud.de';
        } catch (e) { }
    }
}

function saveCredentials() {
    const creds = {
        clientId: $('clientId').value,
        clientSecret: $('clientSecret').value,
        region: $('region').value
    };
    localStorage.setItem('gc_credentials', JSON.stringify(creds));
}

// ============================================
// FILE UPLOAD HANDLING
// ============================================
function setupFileUpload() {
    const uploadZone = $('uploadZone');
    const fileInput = $('csvFile');

    uploadZone.addEventListener('click', () => fileInput.click());

    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('drag-over');
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFileSelect(files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
    });
}

function handleFileSelect(file) {
    if (!file.name.endsWith('.csv')) {
        showToast('error', 'Invalid File', 'Please select a CSV file');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        parseCSV(content, file.name);
    };
    reader.readAsText(file);
}

function parseCSV(content, fileName) {
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    state.csvData = lines.map(line => line.split(',')[0].trim()).filter(Boolean);

    if (state.csvData.length === 0) {
        showToast('error', 'Empty File', 'No data found in CSV file');
        return;
    }

    // Update UI
    const uploadZone = $('uploadZone');
    uploadZone.classList.add('has-file');

    $('fileName').textContent = fileName;
    $('fileRecords').textContent = `${state.csvData.length} record(s) found`;
    $('fileInfo').classList.remove('hidden');

    showToast('success', 'File Loaded', `${state.csvData.length} records ready to process`);
    updateActionButton();
}

// ============================================
// AUTHENTICATION
// ============================================
async function authenticate() {
    const clientId = $('clientId').value.trim();
    const clientSecret = $('clientSecret').value.trim();
    const region = $('region').value;

    if (!clientId || !clientSecret) {
        showToast('error', 'Missing Credentials', 'Please enter Client ID and Secret');
        return;
    }

    const btn = $('connectBtn');
    btn.classList.add('loading');
    btn.disabled = true;

    try {
        let response;

        if (state.useProxy) {
            // Use server proxy to avoid CORS
            response = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clientSecret, region })
            });
        } else {
            // Direct API call (may fail due to CORS)
            const authUrl = `https://login.${region}/oauth/token`;
            const credentials = btoa(`${clientId}:${clientSecret}`);

            response = await fetch(authUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'grant_type=client_credentials'
            });
        }

        if (!response.ok) {
            throw new Error(`Authentication failed: ${response.status}`);
        }

        const data = await response.json();
        state.accessToken = data.access_token;
        state.baseUrl = region;

        // Save credentials
        saveCredentials();

        // Update UI
        updateAuthStatus(true);
        showSections();
        showToast('success', 'Connected', 'Successfully authenticated with Genesys Cloud');

    } catch (error) {
        console.error('Auth error:', error);
        showToast('error', 'Connection Failed', error.message);
    } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
    }
}

function updateAuthStatus(connected) {
    const status = $('authStatus');
    const statusText = status.querySelector('.status-text');

    if (connected) {
        status.classList.add('connected');
        statusText.textContent = 'Connected';
    } else {
        status.classList.remove('connected');
        statusText.textContent = 'Not Connected';
    }
}

function showSections() {
    $('uploadSection').classList.remove('hidden');
    $('wrapupSection').classList.remove('hidden');
    updateActionButton();
}

function updateActionButton() {
    const hasData = state.csvData.length > 0;
    const hasToken = !!state.accessToken;

    if (hasData && hasToken) {
        $('actionSection').classList.remove('hidden');
    } else {
        $('actionSection').classList.add('hidden');
    }
}

// ============================================
// DISCONNECT PROCESSING
// ============================================
async function processDisconnect() {
    if (state.isProcessing) return;

    const wrapUpCode = $('wrapUpCode').value.trim();
    if (!wrapUpCode) {
        showToast('error', 'Missing Wrap-up Code', 'Please enter a wrap-up code');
        return;
    }

    state.isProcessing = true;
    state.stats = { processed: 0, found: 0, disconnected: 0, errors: 0 };
    state.logs = [];

    // Show progress
    $('progressSection').classList.remove('hidden');
    $('logSection').classList.remove('hidden');
    $('actionSection').classList.add('hidden');

    const btn = $('processBtn');
    btn.classList.add('loading');
    btn.disabled = true;

    const searchType = $('searchType').value;
    const monthsBack = parseInt($('monthsBack').value) || 3;
    const wrapUpNotes = $('wrapUpNotes').value || '';
    const wrapUpDuration = parseInt($('wrapUpDuration').value) || 1;

    addLog('info', `Starting process for ${state.csvData.length} ${searchType}(s)...`);

    for (let i = 0; i < state.csvData.length; i++) {
        const attribute = state.csvData[i];
        updateProgress(i + 1, state.csvData.length);

        try {
            addLog('info', `Processing ${i + 1}/${state.csvData.length}: ${attribute}`);

            let conversations = [];

            if (searchType === 'conversationid') {
                // For conversation IDs, use them directly - no need to search
                conversations = [attribute];
                addLog('info', `Using conversation ID directly: ${attribute}`);
            } else {
                // For case IDs, search via analytics
                conversations = await findConversations(attribute, searchType, monthsBack);

                if (conversations.length === 0) {
                    addLog('warning', `No active conversations found for ${attribute}`);
                    state.stats.processed++;
                    continue;
                }
            }

            state.stats.found += conversations.length;
            addLog('info', `Found ${conversations.length} conversation(s) for ${attribute}`);

            // Disconnect each conversation
            for (const convId of conversations) {
                try {
                    await disconnectConversation(convId, wrapUpCode, wrapUpNotes, wrapUpDuration);
                    state.stats.disconnected++;
                    addLog('success', `Disconnected: ${convId}`);
                    await sleep(500); // Rate limiting
                } catch (err) {
                    state.stats.errors++;
                    addLog('error', `Failed to disconnect ${convId}: ${err.message}`);
                }
            }

            state.stats.processed++;

        } catch (error) {
            state.stats.errors++;
            addLog('error', `Error processing ${attribute}: ${error.message}`);
        }

        updateStats();
    }

    // Complete
    state.isProcessing = false;
    btn.classList.remove('loading');
    btn.disabled = false;
    $('actionSection').classList.remove('hidden');

    addLog('success', '='.repeat(40));
    addLog('success', 'Processing complete!');
    addLog('info', `Total processed: ${state.stats.processed}`);
    addLog('info', `Total found: ${state.stats.found}`);
    addLog('info', `Total disconnected: ${state.stats.disconnected}`);
    addLog('info', `Total errors: ${state.stats.errors}`);

    showToast('success', 'Complete', `Disconnected ${state.stats.disconnected} conversation(s)`);
}

async function findConversations(attribute, searchType, monthsBack) {
    const allConversations = [];
    const now = new Date();
    const daysInMonth = 30;

    for (let i = 1; i <= monthsBack; i++) {
        const startDate = new Date(now.getTime() - (i * daysInMonth * 24 * 60 * 60 * 1000));
        const endDate = new Date(startDate.getTime() + (daysInMonth * 24 * 60 * 60 * 1000));

        const startStr = startDate.toISOString().slice(0, -1) + 'Z';
        const endStr = endDate.toISOString().slice(0, -1) + 'Z';

        let pageNumber = 1;

        while (true) {
            const query = {
                interval: `${startStr}/${endStr}`,
                order: 'asc',
                orderBy: 'conversationStart',
                paging: { pageSize: 100, pageNumber },
                conversationFilters: [{
                    type: 'and',
                    predicates: [
                        {
                            dimension: searchType === 'caseid' ? 'externalTag' : 'conversationId',
                            operator: 'matches',
                            value: attribute
                        },
                        { dimension: 'conversationEnd', operator: 'notExists' }
                    ]
                }]
            };

            const response = await apiRequest('POST', '/api/v2/analytics/conversations/details/query', query);

            if (!response.ok) break;

            const data = await response.json();
            const conversations = data.conversations || [];

            if (conversations.length > 0) {
                allConversations.push(...conversations.map(c => c.conversationId));
            }

            const totalHits = data.totalHits || 0;
            if (conversations.length < 100 || allConversations.length >= totalHits) break;

            pageNumber++;
            await sleep(500);
        }
    }

    return [...new Set(allConversations)]; // Remove duplicates
}

async function disconnectConversation(conversationId, wrapUpCode, wrapUpNotes, wrapUpDuration) {
    // Disconnect the conversation
    const disconnectResponse = await apiRequest('POST', `/api/v2/conversations/${conversationId}/disconnect`);

    if (!disconnectResponse.ok) {
        throw new Error(`Disconnect failed: ${disconnectResponse.status}`);
    }

    // Get conversation details to find ACD participant
    const convResponse = await apiRequest('GET', `/api/v2/conversations/${conversationId}`);

    if (!convResponse.ok) {
        throw new Error(`Failed to get conversation details`);
    }

    const convData = await convResponse.json();
    const acdParticipant = convData.participants?.find(
        p => p.conversationRoutingData && p.purpose === 'acd'
    );

    if (!acdParticipant) {
        console.warn(`No ACD participant found for ${conversationId}`);
        return;
    }

    // Update wrap-up
    const wrapUpData = {
        wrapup: {
            durationSeconds: wrapUpDuration,
            code: wrapUpCode,
            notes: wrapUpNotes
        }
    };

    await apiRequest('PATCH', `/api/v2/conversations/${conversationId}/participants/${acdParticipant.id}`, wrapUpData);
}

// ============================================
// API HELPERS
// ============================================
async function apiRequest(method, endpoint, body = null) {
    let url;
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${state.accessToken}`,
            'Content-Type': 'application/json'
        }
    };

    if (state.useProxy) {
        // Use server proxy
        url = `/api/proxy${endpoint}`;
        options.headers['x-gc-region'] = state.baseUrl;
    } else {
        // Direct API call
        url = `https://api.${state.baseUrl}${endpoint}`;
    }

    if (body) {
        options.body = JSON.stringify(body);
    }

    return fetch(url, options);
}

// ============================================
// UI HELPERS
// ============================================
function updateProgress(current, total) {
    const percent = Math.round((current / total) * 100);
    $('progressFill').style.width = `${percent}%`;
    $('progressText').textContent = `Processing ${current} of ${total}...`;
}

function updateStats() {
    $('statProcessed').textContent = state.stats.processed;
    $('statFound').textContent = state.stats.found;
    $('statDisconnected').textContent = state.stats.disconnected;
    $('statErrors').textContent = state.stats.errors;
}

function addLog(type, message) {
    const time = new Date().toLocaleTimeString();
    const entry = { time, type, message };
    state.logs.push(entry);

    const container = $('logContainer');
    const div = document.createElement('div');
    div.className = `log-entry ${type}`;
    div.innerHTML = `<span class="log-time">[${time}]</span><span class="log-message">${message}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function togglePassword(inputId) {
    const input = $(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

function showToast(type, title, message) {
    const container = $('toastContainer');

    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
        </button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function exportLog() {
    if (state.logs.length === 0) {
        showToast('warning', 'No Logs', 'There are no logs to export');
        return;
    }

    const content = state.logs.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.message}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `disconnect-log-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();

    URL.revokeObjectURL(url);
    showToast('success', 'Exported', 'Log file downloaded');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
