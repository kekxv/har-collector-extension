// src/fallback/main.ts

// --- Manager section ---
const capturedLabel = document.getElementById('captured-label')!;
const requestCountEl = document.getElementById('request-count')!;
const requestListEl = document.getElementById('request-list')!;
const loadMoreContainer = document.getElementById('load-more')!;
const loadMoreBtn = document.getElementById('load-more-btn') as HTMLButtonElement;
const splitFilesInput = document.getElementById('split-files-input') as HTMLInputElement;
const splitLabel = document.getElementById('split-label')!;
const saveHarButton = document.getElementById('save-har-button') as HTMLButtonElement;
const clearDataButton = document.getElementById('clear-data-button') as HTMLButtonElement;

// --- Download section ---
const titleEl = document.getElementById('title')!;
const subtitleEl = document.getElementById('subtitle')!;
const spinnerEl = document.getElementById('spinner')!;
const messageEl = document.getElementById('message')!;
const progressBar = document.getElementById('progress-bar')!;
const progressFill = document.getElementById('progress-fill')!;
const progressText = document.getElementById('progress-text')!;
const fileListEl = document.getElementById('file-list')!;
const statsEl = document.getElementById('stats')!;

// --- Sections ---
const managerSection = document.getElementById('manager-section')!;
const downloadSection = document.getElementById('download-section')!;

// i18n helper — static strings only
function msg(key: string): string {
    return chrome.i18n.getMessage(key);
}

// --- Manager state ---
let listOffset = 0;
const LIST_LIMIT = 50;

// --- Download state ---
let totalChunks = 1;
let baseFilename = '';
let totalCount = 0;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showSpinner(show: boolean) {
    spinnerEl.style.display = show ? 'block' : 'none';
}

function setProgress(current: number, total: number) {
    progressBar.style.display = 'block';
    const pct = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `File ${current} of ${total}`;
}

function statusLabel(status: string): string {
    const labels: Record<string, string> = {
        pending: msg('fallbackFileStatusPending') || 'Pending',
        preparing: msg('fallbackFileStatusPreparing') || 'Preparing',
        downloading: msg('fallbackFileStatusDownloading') || 'Downloading',
        done: msg('fallbackFileStatusDone') || 'Done',
        error: msg('fallbackFileStatusError') || 'Error',
    };
    return labels[status] || status;
}

function addFileItem(filename: string, status: string) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `file-${filename}`;
    item.innerHTML = `
        <span>${filename}</span>
        <span class="status ${status}" id="file-status-${filename}">${statusLabel(status)}</span>
    `;
    fileListEl.appendChild(item);
}

function updateFileStatus(filename: string, newStatus: string) {
    const statusEl = document.getElementById(`file-status-${filename}`);
    if (statusEl) {
        statusEl.className = `status ${newStatus}`;
        statusEl.textContent = statusLabel(newStatus);
    }
}

function setError(msgText: string) {
    titleEl.textContent = msg('fallbackDownloadFailed') || 'Download failed';
    subtitleEl.textContent = '';
    showSpinner(false);
    progressBar.style.display = 'none';
    messageEl.textContent = msgText;
    messageEl.className = 'error';
    setTimeout(() => window.close(), 5000);
}

function setSuccess() {
    titleEl.textContent = msg('fallbackAllDone') || 'All files downloaded!';
    subtitleEl.textContent = `${totalCount} entries saved`;
    showSpinner(false);
    messageEl.textContent = msg('fallbackAutoClose') || 'Closing in 3 seconds...';
    messageEl.className = 'success';
    setTimeout(() => window.close(), 3000);
}

function downloadChunk(json: string, filename: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const blob = new Blob([json], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, () => {
            URL.revokeObjectURL(blobUrl);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

function showDownloadMode() {
    managerSection.classList.add('hidden');
    downloadSection.classList.add('active');
}

function showManagerMode() {
    managerSection.classList.remove('hidden');
    downloadSection.classList.remove('active');
}

// --- Manager: request list ---
function methodClass(method: string): string {
    const lower = method.toLowerCase();
    if (lower === 'get') return 'method-get';
    if (lower === 'post') return 'method-post';
    if (lower === 'put') return 'method-put';
    if (lower === 'delete') return 'method-delete';
    if (lower === 'patch') return 'method-patch';
    return 'method-other';
}

function statusClass(status: number | undefined): string {
    if (!status) return 'status-other';
    if (status >= 200 && status < 300) return 'status-2xx';
    if (status >= 300 && status < 400) return 'status-3xx';
    if (status >= 400 && status < 500) return 'status-4xx';
    if (status >= 500) return 'status-5xx';
    return 'status-other';
}

function renderRequestList(items: Array<{ method: string; url: string; status: number | undefined }>, append: boolean = false) {
    if (!append) requestListEl.innerHTML = '';
    for (const item of items) {
        const el = document.createElement('div');
        el.className = 'request-item';
        el.innerHTML = `
            <span class="request-method ${methodClass(item.method)}">${item.method}</span>
            <span class="request-url" title="${item.url}">${item.url}</span>
            <span class="request-status ${statusClass(item.status)}">${item.status ?? '-'}</span>
        `;
        requestListEl.appendChild(el);
    }
}

async function loadRequestList(append: boolean = false) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_REQUEST_LIST',
            offset: listOffset,
            limit: LIST_LIMIT,
        });
        if (response && response.items) {
            renderRequestList(response.items, append);
            listOffset += response.items.length;
            if (response.items.length >= LIST_LIMIT && listOffset < response.total) {
                loadMoreContainer.style.display = 'block';
            } else {
                loadMoreContainer.style.display = 'none';
            }
        }
    } catch { /* ignore */ }
}

// --- Download flow ---
async function processChunks(meta: { totalCount: number; totalChunks: number; baseFilename: string }) {
    totalCount = meta.totalCount;
    totalChunks = meta.totalChunks;
    baseFilename = meta.baseFilename;

    showSpinner(false);
    titleEl.textContent = msg('fallbackDownloadTitle') || 'Downloading HAR files';
    subtitleEl.textContent = `${totalCount} entries · ${totalChunks} file${totalChunks > 1 ? 's' : ''}`;
    fileListEl.innerHTML = '';

    for (let i = 1; i <= totalChunks; i++) {
        const filename = baseFilename.replace('.har', totalChunks > 1 ? `-${String(i).padStart(3, '0')}.har` : '.har');
        addFileItem(filename, i === 1 ? 'preparing' : 'pending');
    }

    let totalBytes = 0;
    let successCount = 0;

    for (let i = 1; i <= totalChunks; i++) {
        const filename = baseFilename.replace('.har', totalChunks > 1 ? `-${String(i).padStart(3, '0')}.har` : '.har');
        updateFileStatus(filename, 'downloading');
        setProgress(i, totalChunks);
        progressText.textContent = `Requesting file ${i} of ${totalChunks}...`;

        try {
            const chunk = await chrome.runtime.sendMessage({
                type: 'FALLBACK_REQUEST_CHUNK',
                chunkIndex: i,
            });

            if (!chunk || chunk.error) {
                updateFileStatus(filename, 'error');
                setError(`Chunk ${i} failed: ${chunk?.error || 'Unknown'}`);
                return;
            }

            await downloadChunk(chunk.json, chunk.filename);
            updateFileStatus(filename, 'done');
            totalBytes += chunk.json.length;
            successCount++;

            const item = document.getElementById(`file-${filename}`);
            if (item && chunk.filename !== filename) {
                item.id = `file-${chunk.filename}`;
                const statusId = `file-status-${filename}`;
                const statusEl = document.getElementById(statusId);
                if (statusEl) {
                    statusEl.id = `file-status-${chunk.filename}`;
                    const nameSpan = item.querySelector('span');
                    if (nameSpan) nameSpan.textContent = chunk.filename;
                }
            }
        } catch (e) {
            updateFileStatus(filename, 'error');
            setError(`Download failed for file ${i}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        for (let j = i + 1; j <= totalChunks; j++) {
            const nextFilename = baseFilename.replace('.har', totalChunks > 1 ? `-${String(j).padStart(3, '0')}.har` : '.har');
            updateFileStatus(nextFilename, j === i + 1 ? 'preparing' : 'pending');
        }
    }

    statsEl.textContent = `${successCount} files · ${formatBytes(totalBytes)} total`;
    setSuccess();
}

// --- Init manager ---
async function initManager() {
    capturedLabel.textContent = msg('capturedRequests') || 'Captured Requests';
    splitLabel.textContent = msg('splitFiles') || 'Split into files for large data';
    saveHarButton.textContent = msg('saveHarButton') || 'Save as HAR';
    clearDataButton.textContent = msg('clearDataButton') || 'Clear Data';
    loadMoreBtn.textContent = msg('loadMore') || 'Load more';

    const { splitFiles } = await chrome.storage.local.get('splitFiles');
    splitFilesInput.checked = !!splitFiles;

    const { requestCount } = await chrome.storage.local.get('requestCount');
    const count = requestCount || 0;
    requestCountEl.textContent = count.toString();
    if (count > 0) {
        loadRequestList();
    }

    saveHarButton.addEventListener('click', async () => {
        const count = await chrome.runtime.sendMessage({ type: 'FALLBACK_INIT_DOWNLOAD' });
        if (!count || count.error) {
            setError(msg('fallbackNoData') || 'No requests captured.');
            return;
        }
        showDownloadMode();
        await processChunks(count);
    });

    clearDataButton.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
        requestCountEl.textContent = '0';
        requestListEl.innerHTML = '';
        loadMoreContainer.style.display = 'none';
        listOffset = 0;
    });

    loadMoreBtn.addEventListener('click', () => {
        loadMoreBtn.disabled = true;
        loadMoreBtn.textContent = 'Loading...';
        loadRequestList(true).finally(() => {
            loadMoreBtn.disabled = false;
            loadMoreBtn.textContent = msg('loadMore') || 'Load more';
        });
    });

    splitFilesInput.addEventListener('change', () => {
        chrome.storage.local.set({ splitFiles: splitFilesInput.checked });
    });

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message.type === 'UPDATE_COUNT') {
            requestCountEl.textContent = message.count.toString();
            if (message.count > 0 && requestListEl.children.length === 0) {
                listOffset = 0;
                loadRequestList();
            }
        }
    });
}

// --- Legacy storage path ---
async function checkLegacyStorage(): Promise<boolean> {
    try {
        const result = await chrome.storage.local.get('_pendingHarDownload');
        if (result._pendingHarDownload) {
            await chrome.storage.local.remove('_pendingHarDownload');
            const { harString, safeFilename } = result._pendingHarDownload;
            showDownloadMode();
            titleEl.textContent = msg('fallbackDownloadTitle') || 'Downloading HAR file';
            subtitleEl.textContent = safeFilename;
            showSpinner(true);
            await downloadChunk(harString, safeFilename);
            showSpinner(false);
            setSuccess();
            return true;
        }
    } catch { /* continue to manager */ }
    return false;
}

async function main() {
    if (await checkLegacyStorage()) return;
    showManagerMode();
    await initManager();
}

main().catch(e => {
    console.error("Fallback main error:", e);
    showManagerMode();
    titleEl.textContent = msg('fallbackDownloadFailed') || 'Error';
    messageEl.textContent = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
    messageEl.className = 'error';
    setTimeout(() => window.close(), 3000);
});
