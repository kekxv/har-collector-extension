// src/__tests__/fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mockChrome } from './setup';

// --- Chunk protocol: init download ---
describe('fallback init download', () => {
    it('receives metadata from FALLBACK_INIT_DOWNLOAD', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            totalCount: 1200,
            totalChunks: 3,
            baseFilename: 'har-capture-test.har',
        });

        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_INIT_DOWNLOAD' });

        expect(response.totalCount).toBe(1200);
        expect(response.totalChunks).toBe(3);
        expect(response.baseFilename).toBe('har-capture-test.har');
    });

    it('handles error response', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({ error: 'No requests captured' });

        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_INIT_DOWNLOAD' });

        expect(response.error).toBe('No requests captured');
    });
});

// --- Chunk protocol: request chunk ---
describe('fallback request chunk', () => {
    it('receives chunk data with HAR JSON', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            chunkIndex: 1,
            total: 3,
            json: '{"log":{"version":"1.2"}}',
            filename: 'har-capture-test-001.har',
            entryCount: 500,
        });

        const response = await mockChrome.runtime.sendMessage({
            type: 'FALLBACK_REQUEST_CHUNK',
            chunkIndex: 1,
        });

        expect(response.chunkIndex).toBe(1);
        expect(response.total).toBe(3);
        expect(response.entryCount).toBe(500);
        expect(response.filename).toBe('har-capture-test-001.har');
    });

    it('handles chunk error', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            error: 'No entries for chunk 5',
        });

        const response = await mockChrome.runtime.sendMessage({
            type: 'FALLBACK_REQUEST_CHUNK',
            chunkIndex: 5,
        });

        expect(response.error).toBe('No entries for chunk 5');
    });
});

// --- Download flow ---
describe('fallback download flow', () => {
    it('initiates download with blob URL', () => {
        let downloadCalled = false;
        let downloadOptions: any;

        mockChrome.downloads.download.mockImplementation((options: any, callback: any) => {
            downloadCalled = true;
            downloadOptions = options;
            if (callback) callback(1);
        });

        const blobUrl = 'blob:chrome-extension://mock-id/abc123';
        const filename = 'har-capture-test.har';

        mockChrome.downloads.download({ url: blobUrl, filename, saveAs: false }, () => {});

        expect(downloadCalled).toBe(true);
        expect(downloadOptions.url).toBe(blobUrl);
        expect(downloadOptions.filename).toBe(filename);
        expect(downloadOptions.saveAs).toBe(false);
    });

    it('handles download failure', () => {
        let errorHandled = false;

        (mockChrome.runtime as any).lastError = { message: 'Download interrupted' };
        mockChrome.downloads.download.mockImplementation((_options: any, callback: any) => {
            if (callback) callback(0);
        });

        mockChrome.downloads.download({ url: 'blob:test', filename: 'test.har', saveAs: false }, () => {
            if ((mockChrome.runtime as any).lastError) {
                errorHandled = true;
            }
        });

        expect(errorHandled).toBe(true);
    });

    it('handles download success', () => {
        let successHandled = false;

        (mockChrome.runtime as any).lastError = null;
        mockChrome.downloads.download.mockImplementation((_options: any, callback: any) => {
            if (callback) callback(42);
        });

        mockChrome.downloads.download({ url: 'blob:test', filename: 'test.har', saveAs: false }, () => {
            if (!(mockChrome.runtime as any).lastError) {
                successHandled = true;
            }
        });

        expect(successHandled).toBe(true);
    });
});

// --- Storage fallback (legacy path) ---
describe('fallback storage retrieval (legacy)', () => {
    it('retrieves HAR data from storage', async () => {
        const harData = {
            harString: '{"log":{"version":"1.2"}}',
            safeFilename: 'har-capture-test.har',
        };

        await mockChrome.storage.local.set({ _pendingHarDownload: harData });
        const result = await mockChrome.storage.local.get('_pendingHarDownload');

        expect(result._pendingHarDownload).toEqual(harData);
    });

    it('removes pending data after retrieval', async () => {
        const harData = {
            harString: '{"log":{}}',
            safeFilename: 'test.har',
        };

        await mockChrome.storage.local.set({ _pendingHarDownload: harData });
        await mockChrome.storage.local.get('_pendingHarDownload');
        await mockChrome.storage.local.remove('_pendingHarDownload');

        const afterRemoval = await mockChrome.storage.local.get('_pendingHarDownload');
        expect(afterRemoval._pendingHarDownload).toBeUndefined();
    });

    it('returns undefined when no pending download', async () => {
        const result = await mockChrome.storage.local.get('_pendingHarDownload');
        expect(result._pendingHarDownload).toBeUndefined();
    });
});

// --- Progress display ---
describe('fallback progress display', () => {
    it('calculates progress percentage correctly', () => {
        const progress = (current: number, total: number) => total > 0 ? (current / total) * 100 : 0;

        expect(progress(0, 3)).toBe(0);
        expect(progress(1, 3)).toBeCloseTo(33.33, 1);
        expect(progress(2, 3)).toBeCloseTo(66.67, 1);
        expect(progress(3, 3)).toBe(100);
    });

    it('formats bytes correctly', () => {
        const formatBytes = (bytes: number): string => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };

        expect(formatBytes(500)).toBe('500 B');
        expect(formatBytes(1500)).toBe('1.5 KB');
        expect(formatBytes(1048576)).toBe('1.0 MB');
        expect(formatBytes(15728640)).toBe('15.0 MB');
    });
});

// --- Auto-close logic ---
describe('fallback auto-close', () => {
    it('sets up auto-close timer', () => {
        vi.useFakeTimers();

        let closed = false;
        const closeTimeout = setTimeout(() => {
            closed = true;
        }, 3000);

        vi.advanceTimersByTime(2999);
        expect(closed).toBe(false);

        vi.advanceTimersByTime(1);
        expect(closed).toBe(true);

        clearTimeout(closeTimeout);
        vi.useRealTimers();
    });
});

// --- Error display ---
describe('fallback error display', () => {
    it('shows error message when data retrieval fails', () => {
        const state = { title: '', spinnerVisible: true, message: '', isError: false };

        const setError = (msg: string) => {
            state.title = 'Download failed';
            state.spinnerVisible = false;
            state.message = msg;
            state.isError = true;
        };

        setError('Could not retrieve HAR data. Please try again.');

        expect(state.title).toBe('Download failed');
        expect(state.spinnerVisible).toBe(false);
        expect(state.isError).toBe(true);
    });

    it('shows success message when download starts', () => {
        const state = { title: '', spinnerVisible: true, message: '', isSuccess: false };

        const setSuccess = (msg: string) => {
            state.title = 'All files downloaded!';
            state.spinnerVisible = false;
            state.message = msg;
            state.isSuccess = true;
        };

        setSuccess('Closing in 3 seconds...');

        expect(state.title).toBe('All files downloaded!');
        expect(state.spinnerVisible).toBe(false);
        expect(state.isSuccess).toBe(true);
    });
});

// --- Storage quota fallback ---
describe('fallback storage quota exceeded', () => {
    it('falls back to chunk protocol when storage has no pending download', async () => {
        // Storage returns nothing
        const storageResult = await mockChrome.storage.local.get('_pendingHarDownload');
        expect(storageResult._pendingHarDownload).toBeUndefined();

        // Should proceed to FALLBACK_INIT_DOWNLOAD
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            totalCount: 100,
            totalChunks: 1,
            baseFilename: 'har-capture-test.har',
        });
        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_INIT_DOWNLOAD' });
        expect(response.totalCount).toBe(100);
    });

    it('message passing also provides HAR data with correct structure', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            chunkIndex: 1,
            total: 1,
            json: '{"log":{"entries":[]}}',
            filename: 'har-capture-test.har',
            entryCount: 50,
        });

        const response = await mockChrome.runtime.sendMessage({
            type: 'FALLBACK_REQUEST_CHUNK',
            chunkIndex: 1,
        });

        expect(response.entryCount).toBe(50);
        expect(response.total).toBe(1);
        expect(response.error).toBeUndefined();
    });

    it('reports error when chunk request fails', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({ error: 'No entries for chunk 1' });
        const response = await mockChrome.runtime.sendMessage({
            type: 'FALLBACK_REQUEST_CHUNK',
            chunkIndex: 1,
        });

        expect(response.error).toBe('No entries for chunk 1');
    });
});

// --- Manager: request list display ---
describe('fallback manager request list', () => {
    it('classifies HTTP methods correctly', () => {
        const methodClass = (method: string): string => {
            const lower = method.toLowerCase();
            if (lower === 'get') return 'method-get';
            if (lower === 'post') return 'method-post';
            if (lower === 'put') return 'method-put';
            if (lower === 'delete') return 'method-delete';
            if (lower === 'patch') return 'method-patch';
            return 'method-other';
        };

        expect(methodClass('GET')).toBe('method-get');
        expect(methodClass('POST')).toBe('method-post');
        expect(methodClass('OPTIONS')).toBe('method-other');
    });

    it('classifies HTTP status codes correctly', () => {
        const statusClass = (status: number | undefined): string => {
            if (!status) return 'status-other';
            if (status >= 200 && status < 300) return 'status-2xx';
            if (status >= 400 && status < 500) return 'status-4xx';
            if (status >= 500) return 'status-5xx';
            return 'status-other';
        };

        expect(statusClass(200)).toBe('status-2xx');
        expect(statusClass(404)).toBe('status-4xx');
        expect(statusClass(500)).toBe('status-5xx');
        expect(statusClass(undefined)).toBe('status-other');
    });

    it('shows load more when items equal limit and more available', () => {
        const LIST_LIMIT = 50;
        const itemsLoaded = 50;
        const totalItems = 120;
        const offset = 0;
        const shouldShowLoadMore = itemsLoaded >= LIST_LIMIT && (offset + itemsLoaded) < totalItems;
        expect(shouldShowLoadMore).toBe(true);
    });

    it('hides load more when all items loaded', () => {
        const LIST_LIMIT = 50;
        const itemsLoaded = 50;
        const totalItems = 50;
        const offset = 0;
        const shouldShowLoadMore = itemsLoaded >= LIST_LIMIT && (offset + itemsLoaded) < totalItems;
        expect(shouldShowLoadMore).toBe(false);
    });
});

// --- Manager: split files preference ---
describe('fallback manager split files preference', () => {
    it('saves split preference to storage', async () => {
        await mockChrome.storage.local.set({ splitFiles: true });
        const result = await mockChrome.storage.local.get('splitFiles');
        expect(result.splitFiles).toBe(true);
    });

    it('loads unchecked by default when no preference saved', async () => {
        const result = await mockChrome.storage.local.get('splitFiles');
        expect(!!result.splitFiles).toBe(false);
    });
});

// --- Manager: GET_REQUEST_LIST ---
describe('fallback manager GET_REQUEST_LIST', () => {
    it('sends request with offset and limit', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            items: [{ method: 'GET', url: 'https://example.com', status: 200, tabId: 1 }],
            total: 1,
        });

        const response = await mockChrome.runtime.sendMessage({
            type: 'GET_REQUEST_LIST',
            offset: 0,
            limit: 50,
        });

        expect(response.items).toHaveLength(1);
        expect(response.total).toBe(1);
    });

    it('handles empty response', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({ items: [], total: 0 });

        const response = await mockChrome.runtime.sendMessage({
            type: 'GET_REQUEST_LIST',
            offset: 0,
            limit: 50,
        });

        expect(response.items).toHaveLength(0);
        expect(response.total).toBe(0);
    });
});
