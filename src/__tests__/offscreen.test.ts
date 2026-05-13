// src/__tests__/offscreen.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mockChrome } from './setup';

// Simulate the offscreen message handler logic
function offscreenHandler(message: any, _sender: any, sendResponse: (response: any) => void) {
    if (message.target === 'offscreen' && message.type === 'create-blob-url') {
        const blob = new Blob([message.data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        sendResponse({ url });
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return true;
    } else if (message.target === 'offscreen_popup' && message.type === 'DOWNLOAD_HAR') {
        const { harString, safeFilename } = message;
        const blob = new Blob([harString], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);

        mockChrome.downloads.download({
            url: blobUrl,
            filename: safeFilename,
            saveAs: true,
        }, (downloadId: number) => {
            if (mockChrome.runtime.lastError) {
                console.error("Download failed:", mockChrome.runtime.lastError.message);
            } else {
                console.log("Download ID:", downloadId);
            }
            URL.revokeObjectURL(blobUrl);
        });
    }
}

// --- create-blob-url ---
describe('offscreen create-blob-url', () => {
    it('creates a blob and returns URL', () => {
        const harData = '{"log":{"version":"1.2"}}';
        let response: any = null;

        const returned = offscreenHandler(
            { target: 'offscreen', type: 'create-blob-url', data: harData },
            {},
            (res: any) => { response = res; }
        );

        expect(returned).toBe(true);
        expect(response).not.toBeNull();
        expect(response.url).toBeDefined();
        expect(typeof response.url).toBe('string');
        expect(response.url.startsWith('blob:')).toBe(true);
    });

    it('returns true to indicate async response', () => {
        const returned = offscreenHandler(
            { target: 'offscreen', type: 'create-blob-url', data: '{}' },
            {},
            () => {}
        );

        expect(returned).toBe(true);
    });

    it('creates blob with application/octet-stream MIME type', () => {
        // The blob type is hardcoded as 'application/octet-stream'
        // This test verifies the handler uses the correct type
        const data = 'test data';
        let blob: Blob | null = null;

        // Patch URL.createObjectURL to capture the blob
        const origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = (b: Blob) => {
            blob = b;
            return 'blob:test';
        };

        offscreenHandler(
            { target: 'offscreen', type: 'create-blob-url', data },
            {},
            () => {}
        );

        URL.createObjectURL = origCreateObjectURL;

        expect(blob).not.toBeNull();
        expect(blob!.type).toBe('application/octet-stream');
    });

    it('schedules blob URL cleanup after 60 seconds', () => {
        vi.useFakeTimers();

        let revoked = false;
        const testUrl = 'blob:test-url';
        const origCreateObjectURL = URL.createObjectURL;
        const origRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = () => testUrl;
        URL.revokeObjectURL = (url: string) => {
            if (url === testUrl) revoked = true;
        };

        offscreenHandler(
            { target: 'offscreen', type: 'create-blob-url', data: '{}' },
            {},
            () => {}
        );

        expect(revoked).toBe(false);

        vi.advanceTimersByTime(59999);
        expect(revoked).toBe(false);

        vi.advanceTimersByTime(1);
        expect(revoked).toBe(true);

        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
        vi.useRealTimers();
    });
});

// --- DOWNLOAD_HAR ---
describe('offscreen DOWNLOAD_HAR', () => {
    it('initiates download with provided filename', () => {
        let downloadCalled = false;
        let downloadOpts: any = null;

        mockChrome.downloads.download.mockImplementation((opts: any, cb: (id: number) => void) => {
            downloadCalled = true;
            downloadOpts = opts;
            cb(42);
        });

        offscreenHandler(
            {
                target: 'offscreen_popup',
                type: 'DOWNLOAD_HAR',
                harString: '{"log":{}}',
                safeFilename: 'my-har.har',
            },
            {},
            () => {}
        );

        expect(downloadCalled).toBe(true);
        expect(downloadOpts.filename).toBe('my-har.har');
        expect(downloadOpts.saveAs).toBe(true);

        mockChrome.downloads.download.mockRestore();
    });

    it('handles download error', () => {
        let errorLogged = false;
        (mockChrome.runtime as any).lastError = { message: 'File write error' };

        mockChrome.downloads.download.mockImplementation((_opts: any, cb: (id: number) => void) => {
            cb(0);
        });

        // Capture console.error
        const origError = console.error;
        console.error = (msg: string) => {
            if (msg.includes('Download failed')) errorLogged = true;
        };

        offscreenHandler(
            { target: 'offscreen_popup', type: 'DOWNLOAD_HAR', harString: '{}', safeFilename: 'test.har' },
            {},
            () => {}
        );

        expect(errorLogged).toBe(true);

        console.error = origError;
        (mockChrome.runtime as any).lastError = null;
        mockChrome.downloads.download.mockRestore();
    });

    it('revokes blob URL after download', () => {
        let revoked = false;
        const testUrl = 'blob:test-download';
        const origRevoke = URL.revokeObjectURL;

        mockChrome.downloads.download.mockImplementation((_opts: any, cb: (id: number) => void) => {
            cb(42);
        });
        URL.revokeObjectURL = (url: string) => {
            if (url === testUrl) revoked = true;
        };
        URL.createObjectURL = () => testUrl;

        offscreenHandler(
            { target: 'offscreen_popup', type: 'DOWNLOAD_HAR', harString: '{}', safeFilename: 'test.har' },
            {},
            () => {}
        );

        expect(revoked).toBe(true);

        URL.revokeObjectURL = origRevoke;
        mockChrome.downloads.download.mockRestore();
    });
});

// --- Unknown message types ---
describe('offscreen unknown messages', () => {
    it('ignores messages without matching target', () => {
        const sentMessages: any[] = [];
        offscreenHandler(
            { target: 'unknown', type: 'SOMETHING' },
            {},
            (res: any) => { sentMessages.push(res); }
        );

        expect(sentMessages).toHaveLength(0);
    });

    it('ignores messages with wrong type', () => {
        const sentMessages: any[] = [];
        offscreenHandler(
            { target: 'offscreen', type: 'WRONG_TYPE' },
            {},
            (res: any) => { sentMessages.push(res); }
        );

        expect(sentMessages).toHaveLength(0);
    });
});
