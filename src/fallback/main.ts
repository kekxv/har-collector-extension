// src/fallback/main.ts

const titleEl = document.getElementById('title')!;
const spinnerEl = document.getElementById('spinner')!;
const messageEl = document.getElementById('message')!;

// i18n helper
function msg(key: string, substitutions?: string | string[]): string {
    return chrome.i18n.getMessage(key, substitutions);
}

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setError(msgText: string) {
    titleEl.textContent = msg('fallbackDownloadFailed') || 'Download failed';
    spinnerEl.style.display = 'none';
    messageEl.textContent = msgText;
    messageEl.classList.add('error');
}

function setSuccess() {
    titleEl.textContent = msg('fallbackDownloadStarted') || 'Download started';
    spinnerEl.style.display = 'none';
    messageEl.textContent = msg('fallbackDownloading') || 'Your HAR file is downloading...';
    messageEl.classList.add('success');
}

async function requestHarDataWithRetry(retries: number): Promise<{ harString: string; safeFilename: string } | null> {
    for (let i = 0; i < retries; i++) {
        try {
            messageEl.textContent = msg('fallbackRetryMsg', [String(i + 1), String(retries)])
                || `Retrieving HAR data (attempt ${i + 1}/${retries})...`;
            const response = await chrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });
            if (response && response.error) {
                throw new Error(response.error);
            }
            if (response && response.harLog) {
                return {
                    harString: JSON.stringify(response.harLog, null, 2),
                    safeFilename: `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`,
                };
            }
        } catch (e) {
            console.warn(`Attempt ${i + 1} failed:`, e);
            if (i < retries - 1) {
                await sleep(RETRY_DELAY);
            }
        }
    }
    return null;
}

async function downloadFromStorage(): Promise<{ harString: string; safeFilename: string } | null> {
    const result = await chrome.storage.local.get('_pendingHarDownload');
    if (result._pendingHarDownload) {
        await chrome.storage.local.remove('_pendingHarDownload');
        return result._pendingHarDownload;
    }
    return null;
}

async function main() {
    titleEl.textContent = msg('fallbackPreparing') || 'Preparing download...';
    messageEl.textContent = msg('fallbackRetrieving') || 'Retrieving HAR data...';

    // Strategy 1: Try storage (pre-stored by background)
    let harData = await downloadFromStorage();

    // Strategy 2: Request from background with retry
    if (!harData) {
        harData = await requestHarDataWithRetry(MAX_RETRIES);
    }

    if (!harData) {
        setError(msg('fallbackNoData') || 'Could not retrieve HAR data. Please try again.');
        setTimeout(() => window.close(), 3000);
        return;
    }

    try {
        const blob = new Blob([harData.harString], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);

        chrome.downloads.download({
            url: blobUrl,
            filename: harData.safeFilename,
            saveAs: true,
        }, (_downloadId) => {
            URL.revokeObjectURL(blobUrl);
            if (chrome.runtime.lastError) {
                setError(chrome.runtime.lastError.message || 'Download failed');
            } else {
                setSuccess();
            }
        });
    } catch (e) {
        setError(msg('fallbackUnexpectedError', e instanceof Error ? e.message : String(e))
            || `Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Auto-close after 3 seconds
    setTimeout(() => {
        window.close();
    }, 3000);
}

main().catch(e => {
    console.error("Fallback main error:", e);
    setError(msg('fallbackUnexpectedError', e instanceof Error ? e.message : String(e))
        || `Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    setTimeout(() => window.close(), 3000);
});
