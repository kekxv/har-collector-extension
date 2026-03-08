// src/background/index.ts

console.log("Background service worker started.");

const protocolVersion = "1.3";

// 状态管理：仅用于内存缓存，核心状态应从 storage 恢复
let debugTargets = new Set<number>();

// 初始化：检查现有的调试目标
async function initialize() {
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
        if (target.attached && target.tabId) {
            debugTargets.add(target.tabId);
        }
    }
    updateRequestCount();
}

initialize();

// IndexedDB 配置
const DB_NAME = 'HarCollectorDB';
const STORE_NAME = 'requests';

async function openDB(): Promise<IDBDatabase> {
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
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const existing = await new Promise<any>((resolve) => {
        const req = store.get([tabId, requestId]);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });

    const newData = existing ? { ...existing, ...data } : { tabId, requestId, ...data };
    store.put(newData);
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
}

async function getRequestsForTab(tabId: number): Promise<any[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const result = await new Promise<any[]>((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => {
            const all = req.result || [];
            resolve(all.filter(r => r.tabId === tabId));
        };
        req.onerror = () => resolve([]);
    });
    db.close();
    return result;
}

async function getAllRequests(): Promise<any[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const result = await new Promise<any[]>((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
    db.close();
    return result;
}

async function clearAllData() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
    await chrome.storage.local.set({ requestCount: 0 });
    chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count: 0 }).catch(() => {});
}

// 初始化
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ isEnabled: false, requestCount: 0 });
});

// 监听消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'START_SNIFFING') {
        startSniffing();
    } else if (message.type === 'STOP_SNIFFING') {
        stopSniffing();
    } else if (message.type === 'CLEAR_DATA') {
        clearAllData();
    } else if (message.type === 'SAVE_HAR') {
        saveHar();
    }
    return true;
});

// 监听标签更新，实现自动挂载
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const { isEnabled } = await chrome.storage.local.get('isEnabled');
    if (isEnabled && changeInfo.status === 'loading' && tab.url?.startsWith('http')) {
        attachDebugger(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (debugTargets.has(tabId)) {
        chrome.debugger.detach({ tabId }).catch(() => {});
        debugTargets.delete(tabId);
        updateRequestCount();
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
        debugTargets.delete(source.tabId);
        console.log(`Debugger detached from tab ${source.tabId}`);
    }
});

async function startSniffing() {
    await chrome.storage.local.set({ isEnabled: true });
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
        if (tab.id) {
            attachDebugger(tab.id);
        }
    }
    console.log(`Sniffing enabled for ${tabs.length} tabs.`);
}

async function stopSniffing() {
    await chrome.storage.local.set({ isEnabled: false });
    // 断开所有已连接的调试器
    const targets = await chrome.debugger.getTargets();
    for (const target of targets) {
        if (target.attached && target.tabId) {
            chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
        }
    }
    debugTargets.clear();
    console.log("Sniffing stopped, all debuggers detached.");
}

function attachDebugger(tabId: number) {
    if (debugTargets.has(tabId)) return;

    chrome.debugger.attach({ tabId }, protocolVersion, () => {
        if (chrome.runtime.lastError) {
            console.warn(`Attach error for tab ${tabId}: ${chrome.runtime.lastError.message}`);
            return;
        }
        debugTargets.add(tabId);
        console.log(`Debugger attached to tab ${tabId}`);
        chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(e => console.error(e));
    });
}

// 核心：处理调试器事件并存入 IndexedDB
chrome.debugger.onEvent.addListener(async (source, method, params) => {
    const tabId = source.tabId;
    if (!tabId) return;

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
        
        // 尝试获取响应体
        chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, async (result: any) => {
            const updateData: any = { encodedDataLength };
            if (!chrome.runtime.lastError && result) {
                updateData.responseBody = result.body;
                updateData.base64Encoded = result.base64Encoded;
            }
            await saveRequest(tabId, requestId, updateData);
            updateRequestCount();
        });
    }
});

async function updateRequestCount() {
    const all = await getAllRequests();
    await chrome.storage.local.set({ requestCount: all.length });
    chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count: all.length }).catch(() => {});
}

async function saveHar() {
    const allRequests = await getAllRequests();
    if (allRequests.length === 0) {
        console.log("No requests captured to save.");
        return;
    }

    const harLog = {
        log: {
            version: "1.2",
            creator: { name: "HarCollector Extension", version: "1.0.1" },
            pages: [],
            entries: allRequests.filter(r => r.response).map(req => {
                const time = (req.endTime - req.startTime) * 1000;
                const bodyText = req.responseBody || "";
                let contentSize = bodyText.length;
                if (req.base64Encoded) {
                    try {
                        contentSize = atob(bodyText).length;
                    } catch (e) {
                        contentSize = bodyText.length;
                    }
                }

                return {
                    startedDateTime: req.startedDateTime,
                    time: time > 0 ? time : 0,
                    request: {
                        method: req.request.method,
                        url: req.request.url,
                        httpVersion: "HTTP/2.0",
                        cookies: [],
                        headers: Object.entries(req.request.headers).map(([name, value]) => ({ name, value: String(value) })),
                        queryString: [],
                        postData: req.request.postData ? {
                            mimeType: req.request.headers['Content-Type'] || '',
                            text: req.request.postData
                        } : undefined,
                        headersSize: -1,
                        bodySize: req.request.postData ? req.request.postData.length : 0,
                    },
                    response: {
                        status: req.response.status,
                        statusText: req.response.statusText,
                        httpVersion: "HTTP/2.0",
                        cookies: [],
                        headers: Object.entries(req.response.headers).map(([name, value]) => ({ name, value: String(value) })),
                        content: {
                            size: contentSize,
                            mimeType: req.response.mimeType,
                            text: req.responseBody,
                            encoding: req.base64Encoded ? "base64" : undefined,
                        },
                        redirectURL: req.response.headers['Location'] || req.response.headers['location'] || '',
                        headersSize: -1,
                        bodySize: req.encodedDataLength || 0,
                    },
                    cache: {},
                    timings: { send: -1, wait: -1, receive: -1, ssl: -1, connect: -1, dns: -1, blocked: -1 },
                };
            }),
        },
    };

    const harString = JSON.stringify(harLog, null, 2);
    const safeFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

    // 确保 Offscreen Document 存在
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

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'create-blob-url',
            target: 'offscreen',
            data: harString,
        });

        if (response && response.url) {
            chrome.downloads.download({
                url: response.url,
                filename: safeFilename,
                saveAs: true,
            });
        }
    } catch (e) {
        console.error("Failed to get a blob URL from offscreen document:", e);
    }
}
