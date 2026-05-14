// src/fallback/main.ts

// --- Manager section ---
const capturedLabel = document.getElementById('captured-label')!;
const requestCountEl = document.getElementById('request-count')!;
const requestListEl = document.getElementById('request-list')!;
const paginationEl = document.getElementById('pagination')!;
const splitFilesInput = document.getElementById('split-files-input') as HTMLInputElement;
const splitLabel = document.getElementById('split-label')!;
const saveHarButton = document.getElementById('save-har-button') as HTMLButtonElement;
const clearDataButton = document.getElementById('clear-data-button') as HTMLButtonElement;

// --- Download section ---
const titleEl = document.getElementById('title')!;
const spinnerEl = document.getElementById('spinner')!;
const progressSubtitleEl = document.getElementById('progress-subtitle')!;
const messageEl = document.getElementById('message')!;
const progressBar = document.getElementById('progress-bar')!;
const progressFill = document.getElementById('progress-fill')!;
const progressText = document.getElementById('progress-text')!;
const fileListEl = document.getElementById('file-list')!;
const statsEl = document.getElementById('stats')!;
const closePageBtn = document.getElementById('close-page-btn') as HTMLButtonElement;
const backToListBtn = document.getElementById('back-to-list-btn') as HTMLButtonElement;

// --- Sections ---
const managerSection = document.getElementById('manager-section')!;
const downloadSection = document.getElementById('download-section')!;

// i18n helper
function msg(key: string): string {
    return chrome.i18n.getMessage(key);
}

// --- Manager state ---
const PAGE_SIZE = 20;
let currentPage = 1;
let totalRecords = 0;

// --- Download state ---
let totalChunks = 1;
let baseFilename = '';
let totalCount = 0;
let useSplitFiles = false;

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
    progressSubtitleEl.textContent = '';
    showSpinner(false);
    progressBar.style.display = 'none';
    messageEl.textContent = msgText;
    messageEl.className = 'error';
    closePageBtn.style.display = 'inline-block';
    backToListBtn.style.display = 'inline-block';
}

function setSuccess() {
    titleEl.textContent = msg('fallbackAllDone') || 'All files downloaded!';
    progressSubtitleEl.textContent = `${totalCount} entries saved`;
    showSpinner(false);
    messageEl.textContent = '';
    messageEl.className = 'success';
    closePageBtn.style.display = 'inline-block';
    backToListBtn.style.display = 'inline-block';
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

// --- Manager: request list pagination ---
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

function renderRequestList(items: Array<{ method: string; url: string; status: number | undefined }>) {
    requestListEl.innerHTML = '';
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

function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    paginationEl.innerHTML = '';

    if (totalPages <= 1) {
        paginationEl.style.display = 'none';
        return;
    }
    paginationEl.style.display = 'flex';

    // Prev button
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '‹ Prev';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
    paginationEl.appendChild(prevBtn);

    // Page numbers
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
        const firstBtn = document.createElement('button');
        firstBtn.textContent = '1';
        firstBtn.addEventListener('click', () => goToPage(1));
        paginationEl.appendChild(firstBtn);
        if (startPage > 2) {
            const dots = document.createElement('span');
            dots.className = 'page-info';
            dots.textContent = '...';
            paginationEl.appendChild(dots);
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        const btn = document.createElement('button');
        btn.textContent = String(i);
        if (i === currentPage) btn.classList.add('active');
        btn.addEventListener('click', () => goToPage(i));
        paginationEl.appendChild(btn);
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const dots = document.createElement('span');
            dots.className = 'page-info';
            dots.textContent = '...';
            paginationEl.appendChild(dots);
        }
        const lastBtn = document.createElement('button');
        lastBtn.textContent = String(totalPages);
        lastBtn.addEventListener('click', () => goToPage(totalPages));
        paginationEl.appendChild(lastBtn);
    }

    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next ›';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    paginationEl.appendChild(nextBtn);

    // Page info
    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `${currentPage} / ${totalPages}`;
    paginationEl.appendChild(info);
}

async function goToPage(page: number) {
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    const offset = (page - 1) * PAGE_SIZE;
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_REQUEST_LIST',
            offset,
            limit: PAGE_SIZE,
        });
        if (response && response.items) {
            renderRequestList(response.items);
            renderPagination();
        }
    } catch { /* ignore */ }
}

async function loadRequestList() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_REQUEST_LIST',
            offset: 0,
            limit: PAGE_SIZE,
        });
        if (response && response.items) {
            totalRecords = response.total;
            renderRequestList(response.items);
            renderPagination();
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
    progressSubtitleEl.textContent = `${totalCount} entries · ${totalChunks} file${totalChunks > 1 ? 's' : ''}`;
    fileListEl.innerHTML = '';
    statsEl.textContent = '';
    messageEl.textContent = '';
    closePageBtn.style.display = 'none';

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
                splitFiles: useSplitFiles,
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
    closePageBtn.textContent = msg('closePage') || 'Close Page';
    backToListBtn.textContent = msg('backToList') || 'Back to List';

    const { splitFiles } = await chrome.storage.local.get('splitFiles');
    splitFilesInput.checked = !!splitFiles;

    const { requestCount } = await chrome.storage.local.get('requestCount');
    const count = requestCount || 0;
    requestCountEl.textContent = count.toString();
    if (count > 0) {
        loadRequestList();
    }

    saveHarButton.addEventListener('click', async () => {
        useSplitFiles = splitFilesInput.checked;
        const count = await chrome.runtime.sendMessage({
            type: 'FALLBACK_INIT_DOWNLOAD',
            splitFiles: useSplitFiles,
        });
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
        paginationEl.style.display = 'none';
        currentPage = 1;
        totalRecords = 0;
    });

    backToListBtn.addEventListener('click', () => {
        showManagerMode();
        loadRequestList();
    });

    splitFilesInput.addEventListener('change', () => {
        chrome.storage.local.set({ splitFiles: splitFilesInput.checked });
    });

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message.type === 'UPDATE_COUNT') {
            requestCountEl.textContent = message.count.toString();
            totalRecords = message.count;
            if (message.count > 0 && requestListEl.children.length === 0) {
                currentPage = 1;
                loadRequestList();
            } else if (message.count === 0) {
                requestListEl.innerHTML = '';
                paginationEl.style.display = 'none';
                totalRecords = 0;
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
            progressSubtitleEl.textContent = safeFilename;
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
    closePageBtn.style.display = 'inline-block';
});
