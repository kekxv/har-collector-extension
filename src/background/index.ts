// src/background/index.ts

console.log("Background service worker started.");

const requests = new Map<number, Map<string, any>>();
const debugTargets = new Map<number, { tabId: number }>();
const protocolVersion = "1.3";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ isEnabled: false, requestCount: 0 });
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
    const { isEnabled } = await chrome.storage.local.get('isEnabled');
    if (isEnabled && changeInfo.status === 'loading' && tab.url?.startsWith('http')) {
        attachDebugger(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (debugTargets.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    debugTargets.delete(tabId);
    requests.delete(tabId);
    updateRequestCount();
  }
});

async function startSniffing() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    attachDebugger(tab.id);
  }
}

function stopSniffing() {
  for (const tabId of debugTargets.keys()) {
    chrome.debugger.detach({ tabId }).catch(() => {});
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

  const debugTarget = { tabId: tabId };
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
    const { requestId, request, timestamp, wallTime } = params as any;
    tabRequests.set(requestId, {
      requestId, url: request.url, request, responses: [],
      startedDateTime: new Date(wallTime * 1000).toISOString(), startTime: timestamp,
    });
  } else if (method === "Network.responseReceived") {
    const { requestId, response, timestamp } = params as any;
    const req = tabRequests.get(requestId);
    if (req) { req.response = response; req.endTime = timestamp; }
  } else if (method === "Network.loadingFinished") {
    const { requestId, encodedDataLength } = params as any;
    const req = tabRequests.get(requestId);
    if (req && req.response) {
      req.encodedDataLength = encodedDataLength;
      chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId }, (result: any) => {
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
  await chrome.storage.local.set({ requestCount: total });
  chrome.runtime.sendMessage({ type: 'UPDATE_COUNT', count: total }).catch(() => {});
}

async function saveHar() {
    // 1. 生成 HAR 字符串 (通用逻辑)
    const harLog = {
      log: {
        version: "1.2", creator: { name: "HarCollector Extension", version: "1.0.0" },
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
              method: req.request.method, url: req.request.url, httpVersion: "HTTP/2.0", cookies: [],
              headers: Object.entries(req.request.headers).map(([name, value]) => ({ name, value })),
              queryString: [], postData: req.request.postData ? { mimeType: req.request.headers['Content-Type'] || '', text: req.request.postData } : undefined,
              headersSize: -1, bodySize: req.request.postData ? req.request.postData.length : 0,
            },
            response: {
              status: req.response.status, statusText: req.response.statusText, httpVersion: "HTTP/2.0", cookies: [],
              headers: Object.entries(req.response.headers).map(([name, value]) => ({ name, value})),
              content: {
                size: req.encodedDataLength, mimeType: req.response.mimeType,
                text: req.response.body, encoding: req.response.base64Encoded ? "base64" : undefined,
              },
              redirectURL: req.response.headers['Location'] || req.response.headers['location'] || '',
              headersSize: -1, bodySize: req.encodedDataLength,
            },
            cache: {}, timings: { send: -1, wait: -1, receive: -1, ssl: -1, connect: -1, dns: -1, blocked: -1 },
          };
          harLog.log.entries.push(entry);
        }
      }
    const harString = JSON.stringify(harLog, null, 2);
    const safeFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;

    // 2. 检查是否支持 Offscreen API (新旧 API 兼容性核心)
    if (chrome.offscreen && chrome.offscreen.createDocument) {
        // 新 API 路径: 使用 Offscreen Document
        console.log("Using Offscreen API path.");
        // 确保 Offscreen Document 存在
        const offscreenUrl = chrome.runtime.getURL('src/offscreen/index.html');
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl]
        });

        if (existingContexts.length === 0) {
            await chrome.offscreen.createDocument({
                url: offscreenUrl, reasons: [chrome.offscreen.Reason.BLOBS],
                justification: 'To download the HAR file.',
            });
        }
        // 将保存任务发送到 offscreen
        chrome.runtime.sendMessage({
            type: 'download-har',
            target: 'offscreen',
            data: harString,
            filename: safeFilename
        });
    } else {
        // 旧 API 路径: 直接在 Background Script 中下载
        console.log("Using direct download path (fallback).");
        const blob = new Blob([harString], {type: 'application/json'});
        const url = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: url,
            filename: safeFilename,
            saveAs: true,
        }, () => {
            // 下载完成后，释放 Blob URL
            URL.revokeObjectURL(url);
        });
    }
}
