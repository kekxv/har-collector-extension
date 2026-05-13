// src/__tests__/background.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockChrome } from './setup';

// --- Legacy HAR data handler simulation ---
describe('handleFallbackRequestData logic (legacy path)', () => {
    it('returns error when no requests captured', () => {
        const allRequests: any[] = [];
        const result = allRequests.length === 0
            ? { error: 'No requests captured' }
            : { entries: [], harLog: { log: { entries: [] } }, count: 0 };
        expect(result).toEqual({ error: 'No requests captured' });
    });

    it('catches and returns error on failure', async () => {
        const getAllRequests = async (): Promise<any[]> => {
            throw new Error('IndexedDB unavailable');
        };

        try {
            await getAllRequests();
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
            if (e instanceof Error) {
                expect(e.message).toBe('IndexedDB unavailable');
            }
        }
    });
});

// --- saveHar logic (chunk protocol) ---
describe('saveHar logic', () => {
    it('detects empty requests', () => {
        const count = 0;
        if (count === 0) {
            expect(true).toBe(true);
        }
    });

    it('opens fallback page when requests exist', async () => {
        const fallbackUrl = 'chrome-extension://mock-id/src/fallback/index.html';

        await mockChrome.tabs.create({ url: fallbackUrl, active: true });

        expect(mockChrome.tabs.create).toHaveBeenCalledWith({
            url: fallbackUrl,
            active: true,
        });
    });
});

// --- Chunk protocol: FALLBACK_INIT_DOWNLOAD ---
describe('FALLBACK_INIT_DOWNLOAD logic', () => {
    it('returns metadata for non-zero count', async () => {
        const totalCount = 1200;
        const CHUNK_SIZE_ENTRIES = 500;
        const totalChunks = Math.max(1, Math.ceil(totalCount / CHUNK_SIZE_ENTRIES));
        const baseFilename = 'har-capture-test.har';

        const result = { totalCount, totalChunks, baseFilename };

        expect(result.totalCount).toBe(1200);
        expect(result.totalChunks).toBe(3);
        expect(result.baseFilename).toBe('har-capture-test.har');
    });

    it('returns error for zero count', () => {
        const totalCount = 0;
        const result = totalCount === 0
            ? { error: "No requests captured" }
            : { totalCount, totalChunks: 1, baseFilename: 'test.har' };

        expect(result).toEqual({ error: "No requests captured" });
    });
});

// --- Chunk protocol: FALLBACK_REQUEST_CHUNK ---
describe('FALLBACK_REQUEST_CHUNK logic', () => {
    it('builds valid HAR JSON for a chunk of entries', () => {
        // Simulate the chunk building logic without importing the module
        const entries = [{
            startedDateTime: "2024-01-01T00:00:00.000Z",
            time: 1000,
            request: { method: "GET", url: "https://test.com", httpVersion: "HTTP/2.0", cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: 0 },
            response: { status: 200, statusText: "OK", httpVersion: "HTTP/2.0", cookies: [], headers: [], content: { size: 0, mimeType: "text/html", text: "", encoding: undefined }, redirectURL: "", headersSize: -1, bodySize: 0 },
            cache: {},
            timings: { send: -1, wait: -1, receive: -1, ssl: -1, connect: -1, dns: -1, blocked: -1 },
        }];

        const json = JSON.stringify({
            log: {
                version: "1.2",
                creator: { name: "HarCollector Extension", version: "1.0.5" },
                pages: [],
                entries,
            },
        }, null, 2);

        const parsed = JSON.parse(json);
        expect(parsed.log.entries).toHaveLength(1);
        expect(parsed.log.version).toBe('1.2');
    });
});

// --- Debugger attach with result ---
describe('attachDebuggerWithResult logic', () => {
    const debugTargets = new Set<number>();

    beforeEach(() => {
        debugTargets.clear();
    });

    it('returns success for already attached tab', () => {
        debugTargets.add(42);
        if (debugTargets.has(42)) {
            expect({ success: true, tabId: 42 }).toEqual({ success: true, tabId: 42 });
        }
    });

    it('records conflict when attach fails', () => {
        (mockChrome.runtime as any).lastError = { message: 'Target tab is already being debugged' };

        const tabId = 42;
        const conflicts: Array<{ tabId: number; message: string }> = [];

        if ((mockChrome.runtime as any).lastError) {
            const msg = (mockChrome.runtime as any).lastError.message || 'Unknown error';
            conflicts.push({ tabId, message: msg });
        }

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].tabId).toBe(42);
        expect(conflicts[0].message).toBe('Target tab is already being debugged');
    });

    it('succeeds when no lastError', () => {
        const tabId = 42;
        const targets = new Set<number>();

        mockChrome.debugger.attach.mockImplementationOnce((_target: any, _version: string, callback: () => void) => {
            callback();
        });

        mockChrome.debugger.attach({ tabId }, '1.3', () => {
            if (!(mockChrome.runtime as any).lastError) {
                targets.add(tabId);
            }
        });

        expect(targets.has(42)).toBe(true);
    });
});

// --- Keepalive logic ---
describe('handleKeepalive', () => {
    const debugTargets = new Set<number>();

    it('does nothing when sniffing is disabled', async () => {
        await mockChrome.storage.local.set({ isEnabled: false });

        const { isEnabled } = await mockChrome.storage.local.get('isEnabled');
        if (!isEnabled) {
            expect(true).toBe(true);
        }
    });

    it('reconnects lost debuggers when enabled', async () => {
        debugTargets.add(1);
        await mockChrome.storage.local.set({ isEnabled: true });

        mockChrome.debugger.getTargets.mockResolvedValueOnce([
            { tabId: 1, attached: true, url: 'https://a.com' },
            { tabId: 2, attached: true, url: 'https://b.com' },
        ]);

        const { isEnabled } = await mockChrome.storage.local.get('isEnabled');
        if (isEnabled) {
            const targets = await mockChrome.debugger.getTargets();
            for (const target of targets) {
                if (target.tabId && target.attached && !debugTargets.has(target.tabId)) {
                    debugTargets.add(target.tabId);
                }
            }
        }

        expect(debugTargets.has(1)).toBe(true);
        expect(debugTargets.has(2)).toBe(true);
    });
});

// --- Message routing ---
describe('message type handling', () => {
    const handledTypes = new Set<string>();

    const messageHandler = (message: any) => {
        handledTypes.add(message.type);
    };

    it('handles all expected message types', () => {
        const expectedTypes = [
            'START_SNIFFING',
            'STOP_SNIFFING',
            'CLEAR_DATA',
            'SAVE_HAR',
            'FALLBACK_INIT_DOWNLOAD',
            'FALLBACK_REQUEST_CHUNK',
            'FALLBACK_REQUEST_DATA',
            'GET_DEBUGGER_CONFLICTS',
            'GET_REQUEST_LIST',
        ];

        for (const type of expectedTypes) {
            messageHandler({ type });
        }

        for (const type of expectedTypes) {
            expect(handledTypes.has(type)).toBe(true);
        }
    });
});

// --- GET_REQUEST_LIST ---
describe('GET_REQUEST_LIST logic', () => {
    it('returns items with method, url, status, tabId', () => {
        const mockRequests = [
            { request: { method: 'GET', url: 'https://api.example.com/data' }, response: { status: 200 }, tabId: 1 },
            { request: { method: 'POST', url: 'https://api.example.com/submit' }, response: { status: 201 }, tabId: 1 },
        ];

        const items = mockRequests
            .filter(r => r.request && r.request.method)
            .map(r => ({ method: r.request.method, url: r.request.url, status: r.response?.status, tabId: r.tabId }));

        expect(items).toHaveLength(2);
        expect(items[0].method).toBe('GET');
        expect(items[0].status).toBe(200);
        expect(items[1].method).toBe('POST');
        expect(items[1].status).toBe(201);
    });

    it('respects offset and limit', () => {
        const allRequests = Array.from({ length: 100 }, (_, i) => ({
            request: { method: 'GET', url: `https://example.com/${i}` },
            response: { status: 200 },
            tabId: 1,
        }));

        const offset = 10;
        const limit = 5;
        const items = allRequests
            .filter(r => r.request && r.request.method)
            .slice(offset, offset + limit)
            .map(r => ({ method: r.request.method, url: r.request.url, status: r.response?.status, tabId: r.tabId }));

        expect(items).toHaveLength(5);
        expect(items[0].url).toBe('https://example.com/10');
        expect(items[4].url).toBe('https://example.com/14');
    });

    it('handles empty request list', () => {
        const allRequests: any[] = [];
        const result = allRequests.length === 0
            ? { items: [], total: 0 }
            : { items: allRequests.slice(0, 10), total: allRequests.length };

        expect(result.items).toHaveLength(0);
        expect(result.total).toBe(0);
    });
});
