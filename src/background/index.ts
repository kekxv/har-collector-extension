/* src/background/index.ts */
import { countRequests, iterateRequestsBatched } from '../lib/idb-cursor.js';
import { CHUNK_SIZE_ENTRIES, generateChunkFilename } from '../lib/streaming-har.js';
import { buildHarEntry, buildHarLog } from '../lib/har-builder.js';

console.log("Background service worker started.");

const protocolVersion = "1.3";

// State management: in-memory cache only, core state restored from storage
let debugTargets = new Set<number>();

// Initialize: check existing debug targets
async function initialize() {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
        if (target.attached && target.tabId) {
            debugTargets.add(target.tabId);
        }
    }
    updateRequestCount().catch(e => console.error("Failed to update request count on init:", e));
}

initialize();

// --- IndexedDB ---
const DB_NAME = 'HarCollectorDB';
const STORE_NAME = 'requests';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: ['tabId', 'requestId'] });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveRequest(tabId: number, requestId: string, data: any) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const existing = await new Promise<any>((resolve, reject) => {
            const req = store.get([tabId, requestId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const newData = existing ? { ...existing, ...data } : { tabId, requestId, ...data };
        store.put(newData);
        await new Promise((resolve) => { tx.oncomplete = resolve; });
        db.close();
    } catch (e) {
        console.error("IndexedDB saveRequest failed:", e);
    }
}

async function getAllRequests(): Promise<any[]> {
    const db = await openDB();
    try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const result = await new Promise<any[]>((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        return result;
    } finally {
        db.close();
    }
}

async function clearAllData() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await new Promise((resolve) => { tx.oncomplete = resolve; });
        db.close();
        await chrome.storage.local.set({ requestCount: 0 });
        chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count: 0 }).catch(() => {});
    } catch (e) {
        console.error("IndexedDB clearAllData failed:", e);
    }
}

// --- Message listener ---
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ isEnabled: false, requestCount: 0 });
});

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    if (message.type === 'START_SNIFFING') {
        startSniffing().catch(e => console.error("startSniffing failed:", e));
    } else if (message.type === 'STOP_SNIFFING') {
        stopSniffing().catch(e => console.error("stopSniffing failed:", e));
    } else if (message.type === 'CLEAR_DATA') {
        clearAllData().catch(e => console.error("clearAllData failed:", e));
    } else if (message.type === 'SAVE_HAR') {
        saveHar().catch(e => {
            console.error("saveHar failed:", e);
            notifyPopup('error', `Failed to save HAR: ${e instanceof Error ? e.message : String(e)}`);
        });
    } else if (message.type === 'FALLBACK_INIT_DOWNLOAD') {
        handleFallbackInitDownload(message.splitFiles).then(data => {
            _sendResponse(data);
        }).catch(e => {
            console.error("FALLBACK_INIT_DOWNLOAD failed:", e);
            _sendResponse({ error: e instanceof Error ? e.message : String(e) });
        });
        return true;
    } else if (message.type === 'FALLBACK_REQUEST_CHUNK') {
        handleFallbackRequestChunk(message.chunkIndex, message.splitFiles).then(data => {
            _sendResponse(data);
        }).catch(e => {
            console.error("FALLBACK_REQUEST_CHUNK failed:", e);
            _sendResponse({ error: e instanceof Error ? e.message : String(e) });
        });
        return true;
    } else if (message.type === 'FALLBACK_REQUEST_DATA') {
        // Legacy path: build full HAR from all data (kept for backward compat with small datasets)
        handleFallbackRequestData().then(data => {
            _sendResponse(data);
        }).catch(e => {
            console.error("FALLBACK_REQUEST_DATA failed:", e);
            _sendResponse({ error: e instanceof Error ? e.message : String(e) });
        });
        return true;
    } else if (message.type === 'GET_DEBUGGER_CONFLICTS') {
        _sendResponse({ conflicts: debuggerConflicts });
        debuggerConflicts = [];
        return true;
    } else if (message.type === 'GET_REQUEST_LIST') {
        handleGetRequestList(message.offset ?? 0, message.limit ?? 50).then(data => {
            _sendResponse(data);
        }).catch(e => {
            console.error("GET_REQUEST_LIST failed:", e);
            _sendResponse({ error: e instanceof Error ? e.message : String(e) });
        });
        return true;
    }
    return true;
});

// --- Tab lifecycle ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        const { isEnabled } = await chrome.storage.local.get('isEnabled');
        if (isEnabled && changeInfo.status === 'loading' && tab.url?.startsWith('http')) {
            attachDebuggerWithResult(tabId).catch(e => console.error("attachDebuggerWithResult failed:", e));
        }
    } catch (e) {
        console.error("onUpdated listener failed:", e);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (debugTargets.has(tabId)) {
        chrome.debugger.detach({ tabId }).catch(() => {});
        debugTargets.delete(tabId);
        updateRequestCount().catch(e => console.error("updateRequestCount failed:", e));
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
        debugTargets.delete(source.tabId);
        console.log(`Debugger detached from tab ${source.tabId}`);
    }
});

// --- Sniffing ---
async function startSniffing() {
    await chrome.storage.local.set({ isEnabled: true });
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
        if (tab.id) {
            await attachDebuggerWithResult(tab.id);
        }
    }
    console.log(`Sniffing enabled for ${tabs.length} tabs.`);
}

async function stopSniffing() {
    await chrome.storage.local.set({ isEnabled: false });
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
        if (target.attached && target.tabId) {
            chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
        }
    }
    debugTargets.clear();
    console.log("Sniffing stopped, all debuggers detached.");
}

// Debugger conflict notifications
let debuggerConflicts: Array<{ tabId: number; message: string }> = [];

async function attachDebuggerWithResult(tabId: number): Promise<{ success: boolean; tabId: number; message?: string }> {
    if (debugTargets.has(tabId)) return { success: true, tabId };

    return new Promise((resolve) => {
        chrome.debugger.attach({ tabId }, protocolVersion, () => {
            if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || 'Unknown error';
                console.warn(`Attach failed for tab ${tabId}: ${msg}`);
                debuggerConflicts.push({ tabId, message: msg });
                resolve({ success: false, tabId, message: msg });
                return;
            }
            debugTargets.add(tabId);
            chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(e => console.error("Network.enable failed:", e));
            resolve({ success: true, tabId });
        });
    });
}

// --- Debugger events ---
chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;

    try {
        if (method === "Network.requestWillBeSent") {
            const { requestId, request, timestamp, wallTime } = params as any;
            await saveRequest(tabId, requestId, {
                url: request.url,
                request,
                responses: [],
                startedDateTime: new Date(wallTime * 1000).toISOString(),
                startTime: timestamp,
            });
        } else if (method === "Network.responseReceived") {
            const { requestId, response, timestamp } = params as any;
            await saveRequest(tabId, requestId, {
                response,
                endTime: timestamp,
            });
        } else if (method === "Network.loadingFinished") {
            const { requestId, encodedDataLength } = params as any;

            chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, async (result: any) => {
                const updateData: any = { encodedDataLength };
                if (!chrome.runtime.lastError && result) {
                    updateData.responseBody = result.body;
                    updateData.base64Encoded = result.base64Encoded;
                }
                await saveRequest(tabId, requestId, updateData);
                updateRequestCount().catch(e => console.error("updateRequestCount failed:", e));
            });
        }
    } catch (e) {
        console.error(`onEvent handler failed for tab ${tabId}, method ${method}:`, e);
    }
});

async function updateRequestCount() {
    try {
        const count = await countRequests();
        await chrome.storage.local.set({ requestCount: count });
        chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count }).catch(() => {});
    } catch (e) {
        console.error("updateRequestCount failed:", e);
    }
}

// --- Notification helper ---
function notifyPopup(level: 'error' | 'success' | 'info', message: string) {
    chrome.runtime.sendMessage({ type: 'NOTIFICATION', level, message }).catch(() => {});
}

// --- Legacy fallback data handler (small datasets) ---
async function handleFallbackRequestData(): Promise<{ entries: any[]; harLog: any; count: number } | { error: string }> {
    try {
        const allRequests = await getAllRequests();
        if (allRequests.length === 0) {
            return { error: "No requests captured" };
        }

        const harLog = buildHarLog(allRequests);

        return { entries: harLog.log.entries, harLog, count: allRequests.length };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// --- saveHar: opens fallback page for chunked download ---
async function saveHar() {
    const count = await countRequests();
    if (count === 0) {
        notifyPopup('info', 'No requests captured to save.');
        console.log("No requests captured to save.");
        return;
    }

    const fallbackUrl = chrome.runtime.getURL('src/fallback/index.html');
    await chrome.tabs.create({ url: fallbackUrl, active: true });
    notifyPopup('info', 'Opening download page...');
}

// --- Chunk protocol: init download ---
async function handleFallbackInitDownload(splitFiles: boolean = true): Promise<{ totalCount: number; totalChunks: number; baseFilename: string } | { error: string }> {
    try {
        const totalCount = await countRequests();
        if (totalCount === 0) {
            return { error: "No requests captured" };
        }

        const totalChunks = splitFiles
            ? Math.max(1, Math.ceil(totalCount / CHUNK_SIZE_ENTRIES))
            : 1;
        const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

        return { totalCount, totalChunks, baseFilename };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// --- Chunk protocol: request a specific chunk ---
async function handleFallbackRequestChunk(chunkIndex: number, splitFiles: boolean = true): Promise<{ chunkIndex: number; total: number; json: string; filename: string; entryCount: number } | { error: string }> {
    try {
        const batchIterator = iterateRequestsBatched({ batchSize: 100 });
        let targetEntries: any[] = [];
        let collected = 0;
        // When splitFiles is false, collect ALL entries (no limit)
        const targetCount = splitFiles ? CHUNK_SIZE_ENTRIES : Infinity;

        for await (const batch of batchIterator) {
            for (const req of batch) {
                if (!req.response || !req.request || !req.request.method) continue;
                targetEntries.push(req);
                collected++;
                if (collected >= targetCount) break;
            }
            if (collected >= targetCount) break;
        }

        if (targetEntries.length === 0) {
            return { error: `No entries for chunk ${chunkIndex}` };
        }

        // Build HAR JSON for this chunk
        const entries = targetEntries.map(buildHarEntry);
        const json = JSON.stringify({
            log: {
                version: "1.2",
                creator: { name: "HarCollector Extension", version: "1.0.5" },
                pages: [],
                entries,
            },
        }, null, 2);

        // Calculate total chunks for filename
        const totalCount = await countRequests();
        const totalChunks = splitFiles
            ? Math.max(1, Math.ceil(totalCount / CHUNK_SIZE_ENTRIES))
            : 1;
        const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;
        const filename = generateChunkFilename(baseFilename, chunkIndex, totalChunks);

        return { chunkIndex, total: totalChunks, json, filename, entryCount: entries.length };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// --- Popup request list ---
interface RequestListItem {
    method: string;
    url: string;
    status: number | undefined;
    tabId: number;
}

async function handleGetRequestList(offset: number, limit: number): Promise<{ items: RequestListItem[]; total: number } | { error: string }> {
    try {
        const total = await countRequests();
        const items: RequestListItem[] = [];
        let skipped = 0;
        const batchIterator = iterateRequestsBatched({ batchSize: 100 });

        for await (const batch of batchIterator) {
            for (const req of batch) {
                if (!req.request || !req.request.method) continue;
                if (skipped < offset) {
                    skipped++;
                    continue;
                }
                items.push({
                    method: req.request.method,
                    url: req.request.url,
                    status: req.response?.status,
                    tabId: req.tabId,
                });
                if (items.length >= limit) break;
            }
            if (items.length >= limit) break;
        }

        return { items, total };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// --- Service Worker keepalive ---
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
        handleKeepalive().catch(e => console.error("keepalive failed:", e));
    }
});

async function handleKeepalive() {
    // Re-attach debuggers that may have been lost
    const { isEnabled } = await chrome.storage.local.get('isEnabled');
    if (!isEnabled) return;

    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
        if (target.tabId && target.attached && !debugTargets.has(target.tabId)) {
            debugTargets.add(target.tabId);
            console.log(`Reconnected debugger for tab ${target.tabId} during keepalive`);
        }
    }
}
