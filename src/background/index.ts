/* src/background/index.ts */
import { countRequests, iterateRequestsBatched, assembleBodies, getAllLegacyRequests } from '../lib/idb-cursor.js';
import { CHUNK_SIZE_ENTRIES, generateChunkFilename, MAX_CHUNK_BYTES } from '../lib/streaming-har.js';
import { buildHarEntry, buildHarLog, estimateEntrySize } from '../lib/har-builder.js';
import { openDB } from '../lib/idb.js';
import { STORE_META, STORE_BODIES } from '../lib/idb-schema.js';

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

// --- IndexedDB: saveRequest (split meta + bodies) ---
async function saveRequest(tabId: number, requestId: string, data: any) {
    try {
        const db = await openDB();
        const tx = db.transaction([STORE_META, STORE_BODIES], 'readwrite');
        const metaStore = tx.objectStore(STORE_META);
        const bodiesStore = tx.objectStore(STORE_BODIES);

        // Read existing meta
        const existing = await new Promise<any>((resolve, reject) => {
            const req = metaStore.get([tabId, requestId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const merged = existing ? { ...existing, ...data } : { tabId, requestId, ...data };

        // Detect if body data arrived in this write
        const hasResponseBody = 'responseBody' in merged;
        const hasPostData = merged.request?.postData !== undefined;

        if (hasResponseBody || hasPostData) {
            const responseBody = merged.responseBody;
            const base64Encoded = merged.base64Encoded;
            const postData = merged.request?.postData;

            // Remove body fields from meta
            delete merged.responseBody;
            delete merged.base64Encoded;

            // Build or update bodyInfo
            const bodyInfo = merged.bodyInfo || {
                hasResponse: false,
                responseTotalSize: 0,
                responseChunks: 0,
                responseBase64Encoded: false,
                hasPostData: false,
                postDataTotalSize: 0,
                postDataChunks: 0,
            };

            // Handle responseBody
            if (typeof responseBody === 'string') {
                const bodySize = new TextEncoder().encode(responseBody).length;
                const encoder = new TextEncoder();
                const bytes = encoder.encode(responseBody);

                if (bytes.length <= MAX_CHUNK_BYTES) {
                    // Single chunk
                    bodiesStore.put({
                        tabId, requestId,
                        bodyType: 'response',
                        chunkIndex: 0,
                        offset: 0,
                        data: responseBody,
                        totalSize: bodySize,
                        isBase64Encoded: !!base64Encoded,
                    });
                    bodyInfo.hasResponse = true;
                    bodyInfo.responseTotalSize = bodySize;
                    bodyInfo.responseChunks = 1;
                } else {
                    // Split into 35MB chunks
                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    let offset = 0;
                    let chunkIndex = 1;
                    let chunkCount = 0;

                    while (offset < bytes.length) {
                        let end = Math.min(offset + MAX_CHUNK_BYTES, bytes.length);
                        while (end > offset && (bytes[end] & 0xc0) === 0x80) end--;
                        if (end === offset) end = Math.min(offset + 1, bytes.length);

                        bodiesStore.put({
                            tabId, requestId,
                            bodyType: 'response',
                            chunkIndex,
                            offset,
                            data: decoder.decode(bytes.slice(offset, end)),
                            totalSize: bodySize,
                            isBase64Encoded: !!base64Encoded,
                        });

                        offset = end;
                        chunkIndex++;
                        chunkCount++;
                    }

                    bodyInfo.hasResponse = true;
                    bodyInfo.responseTotalSize = bodySize;
                    bodyInfo.responseChunks = chunkCount;
                }

                bodyInfo.responseBase64Encoded = !!base64Encoded;
            }

            // Handle postData (request body)
            if (typeof postData === 'string') {
                const postDataSize = new TextEncoder().encode(postData).length;
                if (postDataSize <= MAX_CHUNK_BYTES) {
                    // Keep inline in meta
                    merged.request.postData = postData;
                    bodyInfo.hasPostData = true;
                    bodyInfo.postDataTotalSize = postDataSize;
                    bodyInfo.postDataChunks = 0;
                } else {
                    // Split into chunks
                    const encoder = new TextEncoder();
                    const bytes = encoder.encode(postData);
                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    let offset = 0;
                    let chunkIndex = 1;
                    let chunkCount = 0;

                    while (offset < bytes.length) {
                        let end = Math.min(offset + MAX_CHUNK_BYTES, bytes.length);
                        while (end > offset && (bytes[end] & 0xc0) === 0x80) end--;
                        if (end === offset) end = Math.min(offset + 1, bytes.length);

                        bodiesStore.put({
                            tabId, requestId,
                            bodyType: 'request',
                            chunkIndex,
                            offset,
                            data: decoder.decode(bytes.slice(offset, end)),
                            totalSize: postDataSize,
                            isBase64Encoded: false,
                        });

                        offset = end;
                        chunkIndex++;
                        chunkCount++;
                    }

                    bodyInfo.hasPostData = true;
                    bodyInfo.postDataTotalSize = postDataSize;
                    bodyInfo.postDataChunks = chunkCount;
                    delete merged.request.postData;
                }
            }

            merged.bodyInfo = bodyInfo;
        }

        // Write meta
        metaStore.put(merged);

        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(null);
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) {
        console.error("IndexedDB saveRequest failed:", e);
    }
}

// --- Clear all data ---
async function clearAllData() {
    try {
        const db = await openDB();
        const tx = db.transaction([STORE_META, STORE_BODIES], 'readwrite');
        tx.objectStore(STORE_META).clear();
        tx.objectStore(STORE_BODIES).clear();
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
        const allRequests = await getAllLegacyRequests();
        if (allRequests.length === 0) {
            return { error: "No requests captured" };
        }

        // Enrich with bodies from request_bodies store
        for (const req of allRequests) {
            const { responseBody, base64Encoded, postData } = await assembleBodies(req.tabId, req.requestId);
            if (responseBody !== undefined) {
                req.responseBody = responseBody;
                req.base64Encoded = base64Encoded;
            }
            if (postData !== undefined) {
                req.request.postData = postData;
            }
        }

        const harLog = buildHarLog(allRequests);

        // Check total size
        const jsonSize = new TextEncoder().encode(JSON.stringify(harLog)).length;
        if (jsonSize > 64 * 1024 * 1024) {
            return { error: "HAR data too large for single download. Please use the chunked download option instead." };
        }

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

        // Reset cursor position for new download session
        await chrome.storage.local.set({ fallbackChunkCursor: null });

        let totalChunks: number;
        if (splitFiles) {
            // Estimate total bytes by scanning bodyInfo from metadata
            let estimatedBytes = 0;
            for await (const batch of iterateRequestsBatched({ batchSize: 100 })) {
                for (const meta of batch) {
                    if (!meta.response || !meta.request || !meta.request.method) continue;
                    const bodyInfo = meta.bodyInfo;
                    if (bodyInfo?.hasResponse) estimatedBytes += bodyInfo.responseTotalSize;
                    if (bodyInfo?.hasPostData) estimatedBytes += bodyInfo.postDataTotalSize;
                    estimatedBytes += 5 * 1024; // HAR overhead per entry
                }
            }
            totalChunks = Math.max(1, Math.ceil(estimatedBytes / MAX_OUTPUT_BYTES));
        } else {
            totalChunks = 1;
        }

        const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

        return { totalCount, totalChunks, baseFilename };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// --- Chunk protocol: request a specific chunk ---
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024; // 25MB, well under 64MB even with formatting overhead

async function estimateTotalChunks(): Promise<number> {
    try {
        let estimatedBytes = 0;
        let entryCount = 0;
        for await (const batch of iterateRequestsBatched({ batchSize: 100 })) {
            for (const meta of batch) {
                if (!meta.response || !meta.request || !meta.request.method) continue;
                entryCount++;
                const bodyInfo = meta.bodyInfo;
                if (bodyInfo?.hasResponse) {
                    estimatedBytes += bodyInfo.responseTotalSize;
                }
                if (bodyInfo?.hasPostData) {
                    estimatedBytes += bodyInfo.postDataTotalSize;
                }
                estimatedBytes += 5 * 1024; // HAR overhead per entry
            }
        }
        // If no bodyInfo available (old data), use 100KB default per entry
        if (estimatedBytes === 0 && entryCount > 0) {
            estimatedBytes = entryCount * 100 * 1024;
        }
        if (estimatedBytes === 0) return 1;
        return Math.max(1, Math.ceil(estimatedBytes / MAX_OUTPUT_BYTES));
    } catch {
        return 1;
    }
}

async function handleFallbackRequestChunk(chunkIndex: number, splitFiles: boolean = true): Promise<{
    chunkIndex: number; total: number; json: string; filename: string; entryCount: number; hasMore: boolean
} | { error: string }> {
    try {
        // Read cursor position
        const { fallbackChunkCursor } = await chrome.storage.local.get('fallbackChunkCursor');
        const resumeKey = fallbackChunkCursor as [number, string] | undefined;

        const batchIterator = iterateRequestsBatched({
            batchSize: 100,
            resumeAfterKey: resumeKey,
        });

        let targetEntries: any[] = [];
        let collected = 0;
        let accumulatedBytes = 0;
        let hasMore = false;
        let lastKey: [number, string] | null = null;

        const totalChunks = splitFiles ? await estimateTotalChunks() : 1;

        for await (const batch of batchIterator) {
            for (const meta of batch) {
                if (!meta.response || !meta.request || !meta.request.method) continue;

                lastKey = [meta.tabId, meta.requestId];

                // Assemble bodies on-demand
                const { responseBody, base64Encoded, postData } = await assembleBodies(meta.tabId, meta.requestId);

                const enriched: any = { ...meta };
                if (responseBody !== undefined) {
                    enriched.responseBody = responseBody;
                    enriched.base64Encoded = base64Encoded;
                }
                if (postData !== undefined) {
                    enriched.request = { ...enriched.request, postData };
                }

                const entry = buildHarEntry(enriched);
                const entryBytes = estimateEntrySize(entry);

                // Stop at byte limit (both modes) to avoid 64MB message crash
                if (accumulatedBytes + entryBytes > MAX_OUTPUT_BYTES && collected > 0) {
                    hasMore = true;
                    break;
                }
                // Split-files mode: also stop at count limit
                if (splitFiles && collected >= CHUNK_SIZE_ENTRIES) {
                    hasMore = true;
                    break;
                }

                targetEntries.push(enriched);
                accumulatedBytes += entryBytes;
                collected++;
            }
            if (hasMore) break;
        }

        // Save cursor position if we processed any entries
        if (lastKey && !hasMore) {
            // All done, clear cursor
            await chrome.storage.local.set({ fallbackChunkCursor: null });
        } else if (lastKey && hasMore) {
            await chrome.storage.local.set({ fallbackChunkCursor: lastKey });
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

        const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;
        const filename = generateChunkFilename(baseFilename, chunkIndex, totalChunks);

        return { chunkIndex, total: totalChunks, json, filename, entryCount: entries.length, hasMore };
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
