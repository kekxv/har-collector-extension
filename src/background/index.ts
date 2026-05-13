/* src/background/index.ts */
import { buildHarLog } from '../lib/har-builder.js';

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

// --- Chrome compatibility check ---
function checkChromeCompatibility(): { offscreen: boolean; getContexts: boolean } {
    const hasOffscreen = typeof chrome.offscreen?.createDocument === 'function';
    const hasGetContexts = typeof (chrome.runtime as any).getContexts === 'function';
    return { offscreen: hasOffscreen, getContexts: hasGetContexts };
}

// --- Init ---
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ isEnabled: false, requestCount: 0 });
});

// --- Message listener ---
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
    } else if (message.type === 'FALLBACK_REQUEST_DATA') {
        // Fallback page requests HAR data
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
        const all = await getAllRequests();
        await chrome.storage.local.set({ requestCount: all.length });
        chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count: all.length }).catch(() => {});
    } catch (e) {
        console.error("updateRequestCount failed:", e);
    }
}

// --- Notification helper ---
function notifyPopup(level: 'error' | 'success' | 'info', message: string) {
    chrome.runtime.sendMessage({ type: 'NOTIFICATION', level, message }).catch(() => {});
}

// --- Fallback data handler ---
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

// --- saveHar: 3-layer approach ---
async function saveHar() {
    // Layer 1: Data validation
    const allRequests = await getAllRequests();
    if (allRequests.length === 0) {
        notifyPopup('info', 'No requests captured to save.');
        console.log("No requests captured to save.");
        return;
    }

    const harLog = buildHarLog(allRequests);

    const harString = JSON.stringify(harLog, null, 2);
    const safeFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

    // Layer 2: Offscreen download (with compatibility check)
    const compat = checkChromeCompatibility();
    if (compat.offscreen && compat.getContexts) {
        try {
            const success = await tryOffscreenDownload(harString, safeFilename);
            if (success) {
                notifyPopup('success', `HAR file saved (${allRequests.length} entries).`);
                return;
            }
        } catch (e) {
            console.warn("Offscreen download failed, falling back:", e);
        }
    }

    // Layer 3: Fallback page download
    await tryFallbackPageDownload(harString, safeFilename);
}

async function tryOffscreenDownload(harString: string, safeFilename: string): Promise<boolean> {
    const offscreenUrl = chrome.runtime.getURL('src/offscreen/index.html');
    const existingContexts = await (chrome.runtime as any).getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl]
    });

    if (existingContexts.length === 0) {
        await chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: [chrome.offscreen.Reason.BLOBS],
            justification: 'To create a blob URL for downloading the HAR file.',
        });
    }

    const response = await chrome.runtime.sendMessage({
        type: 'create-blob-url',
        target: 'offscreen',
        data: harString,
    });

    if (!response || !response.url) {
        throw new Error("Offscreen document did not return a blob URL");
    }

    return new Promise((resolve) => {
        chrome.downloads.download({
            url: response.url,
            filename: safeFilename,
            saveAs: true,
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Offscreen download failed:", chrome.runtime.lastError.message);
                resolve(false);
            } else {
                console.log("Offscreen download started, ID:", downloadId);
                resolve(true);
            }
        });
    });
}

async function tryFallbackPageDownload(harString: string, safeFilename: string): Promise<void> {
    console.log("Opening fallback download page...");
    // Try to pre-store HAR data for faster retrieval.
    // For large HAR files, storage.local quota may be exceeded —
    // the fallback page will request data via message passing instead.
    try {
        await chrome.storage.local.set({ _pendingHarDownload: { harString, safeFilename } });
    } catch (e) {
        const quotaError = e instanceof Error && e.message.includes('quota');
        console.warn(
            `Could not pre-store HAR data in storage${quotaError ? ' (quota exceeded)' : ''}. ` +
            'Fallback page will request via message passing.'
        );
    }

    const fallbackUrl = chrome.runtime.getURL('src/fallback/index.html');
    await chrome.tabs.create({ url: fallbackUrl, active: true });

    notifyPopup('info', 'Opening fallback page to download HAR...');
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
