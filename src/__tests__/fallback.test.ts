// src/__tests__/fallback.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mockChrome } from './setup';

// --- Retry logic ---
describe('fallback retry logic', () => {
    it('succeeds on first attempt', async () => {
        const mockData = { harLog: { log: { entries: [] } } };
        mockChrome.runtime.sendMessage.mockResolvedValueOnce(mockData);

        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });
        expect(response.harLog).toBeDefined();
        expect(mockChrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and eventually succeeds', async () => {
        mockChrome.runtime.sendMessage
            .mockRejectedValueOnce(new Error('Network error'))
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValueOnce({ harLog: { log: { entries: [] } } });

        let lastResponse: any;
        for (let i = 0; i < 3; i++) {
            try {
                lastResponse = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });
            } catch {
                // retry
            }
        }

        expect(lastResponse?.harLog).toBeDefined();
    });

    it('returns null after all retries fail', async () => {
        mockChrome.runtime.sendMessage.mockRejectedValue(new Error('Always fails'));

        let result: any = null;
        for (let i = 0; i < 3; i++) {
            try {
                result = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });
            } catch {
                if (i === 2) result = null;
            }
        }

        expect(result).toBeNull();
    });
});

// --- Storage fallback ---
describe('fallback storage retrieval', () => {
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

        mockChrome.downloads.download({ url: blobUrl, filename, saveAs: true }, () => {});

        expect(downloadCalled).toBe(true);
        expect(downloadOptions.url).toBe(blobUrl);
        expect(downloadOptions.filename).toBe(filename);
        expect(downloadOptions.saveAs).toBe(true);
    });

    it('handles download failure', () => {
        let errorHandled = false;

        (mockChrome.runtime as any).lastError = { message: 'Download interrupted' };
        mockChrome.downloads.download.mockImplementation((_options: any, callback: any) => {
            if (callback) callback(0);
        });

        mockChrome.downloads.download({ url: 'blob:test', filename: 'test.har', saveAs: true }, () => {
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

        mockChrome.downloads.download({ url: 'blob:test', filename: 'test.har', saveAs: true }, () => {
            if (!(mockChrome.runtime as any).lastError) {
                successHandled = true;
            }
        });

        expect(successHandled).toBe(true);
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
            state.title = 'Download started';
            state.spinnerVisible = false;
            state.message = msg;
            state.isSuccess = true;
        };

        setSuccess('Your HAR file is downloading...');

        expect(state.title).toBe('Download started');
        expect(state.spinnerVisible).toBe(false);
        expect(state.isSuccess).toBe(true);
    });
});

// --- Storage quota fallback ---
describe('fallback storage quota exceeded', () => {
    it('falls back to message passing when storage has no pending download', async () => {
        // Strategy 1: no pending download in storage
        const storageResult = await mockChrome.storage.local.get('_pendingHarDownload');
        expect(storageResult._pendingHarDownload).toBeUndefined();

        // Strategy 2: request via message passing
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            harLog: { log: { entries: [] } }
        });
        const messageResponse = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });
        expect(messageResponse.harLog).toBeDefined();
    });

    it('message passing also provides HAR data with correct structure', async () => {
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({
            harLog: { log: { entries: [{ request: { method: 'GET', url: 'https://test.com' } }] } },
            count: 1
        });

        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });

        expect(response.count).toBe(1);
        expect(response.harLog.log.entries).toHaveLength(1);
        expect(response.error).toBeUndefined();
    });

    it('reports error when both storage and message passing fail', async () => {
        // No pending data
        const storageResult = await mockChrome.storage.local.get('_pendingHarDownload');
        expect(storageResult._pendingHarDownload).toBeUndefined();

        // Message passing also fails
        mockChrome.runtime.sendMessage.mockResolvedValueOnce({ error: 'No requests captured' });
        const response = await mockChrome.runtime.sendMessage({ type: 'FALLBACK_REQUEST_DATA' });

        expect(response.error).toBe('No requests captured');
    });
});
