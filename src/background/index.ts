// src/background/index.ts

console.log("Background service worker started.");

const requests = new Map<number, Map<string, any>>();
const debugTargets = new Map<number, { tabId: number }>();
const protocolVersion = "1.3";

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({isEnabled: false, requestCount: 0});
});

chrome.runtime.onMessage.addListener((message, _sender) => {
    if (message.type === 'START_SNIFFING') {
        startSniffing();
    } else if (message.type === 'STOP_SNIFFING') {
        stopSniffing();
    } else if (message.type === 'CLEAR_DATA') {
        clearData();
    } else if (message.type === 'SAVE_HAR') {
        saveHar();
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const {isEnabled} = await chrome.storage.local.get('isEnabled');
    if (isEnabled && changeInfo.status === 'loading' && tab.url?.startsWith('http')) {
        attachDebugger(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (debugTargets.has(tabId)) {
        chrome.debugger.detach({tabId}).catch(() => {
        });
        debugTargets.delete(tabId);
        requests.delete(tabId);
        updateRequestCount();
    }
});

async function startSniffing() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab && tab.id) {
        attachDebugger(tab.id);
    }
}

function stopSniffing() {
    for (const tabId of debugTargets.keys()) {
        chrome.debugger.detach({tabId}).catch(() => {
        });
    }
    debugTargets.clear();
    requests.clear();
    updateRequestCount();
    console.log("Sniffing stopped, all debuggers detached.");
}

function clearData() {
    requests.clear();
    updateRequestCount();
    console.log("All captured data cleared.");
}

function attachDebugger(tabId: number) {
    if (debugTargets.has(tabId)) return;

    const debugTarget = {tabId: tabId};
    debugTargets.set(tabId, debugTarget);
    requests.set(tabId, new Map());

    chrome.debugger.attach(debugTarget, protocolVersion, () => {
        if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message);
            debugTargets.delete(tabId);
            return;
        }
        console.log(`Debugger attached to tab ${tabId}`);
        chrome.debugger.sendCommand(debugTarget, "Network.enable", {}).catch(e => console.error(e));
    });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId || !requests.has(tabId)) return;

    const tabRequests = requests.get(tabId)!;

    if (method === "Network.requestWillBeSent") {
        const {requestId, request, timestamp, wallTime} = params as any;
        tabRequests.set(requestId, {
            requestId, url: request.url, request, responses: [],
            startedDateTime: new Date(wallTime * 1000).toISOString(), startTime: timestamp,
        });
    } else if (method === "Network.responseReceived") {
        const {requestId, response, timestamp} = params as any;
        const req = tabRequests.get(requestId);
        if (req) {
            req.response = response;
            req.endTime = timestamp;
        }
    } else if (method === "Network.loadingFinished") {
        const {requestId, encodedDataLength} = params as any;
        const req = tabRequests.get(requestId);
        if (req && req.response) {
            req.encodedDataLength = encodedDataLength;
            chrome.debugger.sendCommand({tabId}, "Network.getResponseBody", {requestId}, (result: any) => {
                if (!chrome.runtime.lastError && result) {
                    req.response.body = result.body;
                    req.response.base64Encoded = result.base64Encoded;
                }
                updateRequestCount();
            });
        }
    }
});

async function updateRequestCount() {
    let total = 0;
    requests.forEach(tabRequests => total += tabRequests.size);
    await chrome.storage.local.set({requestCount: total});
    chrome.runtime.sendMessage({type: 'UPDATE_COUNT', count: total}).catch(() => {
    });
}

async function saveHar() {
    // 1. 生成 HAR 字符串 (通用逻辑)
    const harLog = {
        log: {
            version: "1.2", creator: {name: "HarCollector Extension", version: "1.0.0"},
            pages: [], entries: [] as any[],
        },
    };
    for (const tabRequests of requests.values()) {
        for (const req of tabRequests.values()) {
            if (!req.response) continue;
            const time = (req.endTime - req.startTime) * 1000;
            const entry = {
                startedDateTime: req.startedDateTime, time: time > 0 ? time : 0,
                request: {
                    method: req.request.method,
                    url: req.request.url,
                    httpVersion: "HTTP/2.0",
                    cookies: [],
                    headers: Object.entries(req.request.headers).map(([name, value]) => ({name, value})),
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
                    headers: Object.entries(req.response.headers).map(([name, value]) => ({name, value})),
                    content: {
                        size: req.encodedDataLength, mimeType: req.response.mimeType,
                        text: req.response.body, encoding: req.response.base64Encoded ? "base64" : undefined,
                    },
                    redirectURL: req.response.headers['Location'] || req.response.headers['location'] || '',
                    headersSize: -1,
                    bodySize: req.encodedDataLength,
                },
                cache: {}, timings: {send: -1, wait: -1, receive: -1, ssl: -1, connect: -1, dns: -1, blocked: -1},
            };
            harLog.log.entries.push(entry);
        }
    }
    const harString = JSON.stringify(harLog, null, 2);
    const safeFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

    if (!chrome.offscreen || !chrome.offscreen.createDocument) {
        // 旧 API 路径: 弹出一个网页进行下载
        // 创建一个新窗口来处理下载，因为旧版本不支持 offscreen
        const popupWindow = await chrome.windows.create({
            url: chrome.runtime.getURL('src/offscreen/index.html'), // 使用 offscreen 的 HTML 作为弹出页
            type: 'popup',
            width: 600,
            height: 400,
            focused: true
        });

        if (popupWindow && popupWindow.id) {
            // 等待页面加载完成，然后发送消息
            // 实际应用中可能需要更健壮的等待机制，例如监听 tab.onUpdated
            setTimeout(() => {
                chrome.runtime.sendMessage({
                    type: 'DOWNLOAD_HAR',
                    harString: harString,
                    safeFilename: safeFilename,
                    target: 'offscreen_popup' // 标记给 offscreen/main.ts 区分处理
                }).catch(e => console.error("Failed to send message to popup:", e));
            }, 500); // 延迟发送，确保页面有时间加载
        } else {
            console.error("Failed to create popup window for download.");
        }
        return;
    }
    // 2. 确保 Offscreen Document 存在
    const offscreenUrl = chrome.runtime.getURL('src/offscreen/index.html');
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl]
    });

    if (existingContexts.length === 0) {
        await chrome.offscreen.createDocument({
            url: offscreenUrl, reasons: [chrome.offscreen.Reason.BLOBS],
            justification: 'To create a blob URL for downloading the HAR file.',
        });
    }

    // 3. 向 Offscreen Document 请求 Blob URL
    const {url: blobUrl} = await chrome.runtime.sendMessage({
        type: 'create-blob-url',
        target: 'offscreen',
        data: harString,
    });

    // 4. Background Script 执行下载
    if (blobUrl) {
        chrome.downloads.download({
            url: blobUrl,
            filename: safeFilename, // 使用安全的文件名
            saveAs: true,
        });
    } else {
        console.error("Failed to get a blob URL from offscreen document.");
    }
}