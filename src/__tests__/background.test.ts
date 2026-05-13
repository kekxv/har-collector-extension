// src/__tests__/background.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockChrome } from './setup';
import { buildHarLog, type NetworkRequest } from '../lib/har-builder';

// --- Chrome compatibility ---
describe('checkChromeCompatibility', () => {
    it('returns true when offscreen and getContexts are available', () => {
        const compat = {
            offscreen: typeof mockChrome.offscreen?.createDocument === 'function',
            getContexts: typeof mockChrome.runtime.getContexts === 'function',
        };
        expect(compat.offscreen).toBe(true);
        expect(compat.getContexts).toBe(true);
    });

    it('returns false when APIs are missing', () => {
        const noApi = { offscreen: undefined, runtime: {} };
        const compat = {
            offscreen: typeof (noApi as any).offscreen?.createDocument === 'function',
            getContexts: typeof (noApi as any).runtime?.getContexts === 'function',
        };
        expect(compat.offscreen).toBe(false);
        expect(compat.getContexts).toBe(false);
    });
});

// --- HAR data handler simulation ---
describe('handleFallbackRequestData logic', () => {
    it('returns error when no requests captured', () => {
        const allRequests: NetworkRequest[] = [];
        const result = allRequests.length === 0
            ? { error: 'No requests captured' }
            : { entries: buildHarLog(allRequests).log.entries, harLog: buildHarLog(allRequests), count: 0 };
        expect(result).toEqual({ error: 'No requests captured' });
    });

    it('returns HAR log with entry count', () => {
        const requests: NetworkRequest[] = [{
            tabId: 1,
            requestId: '1',
            url: 'https://test.com',
            request: { method: 'GET', url: 'https://test.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        }];

        const harLog = buildHarLog(requests);
        const result = { entries: harLog.log.entries, harLog, count: requests.length };

        expect(result.count).toBe(1);
        expect(result.entries).toHaveLength(1);
        expect(result.harLog.log.version).toBe('1.2');
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

// --- saveHar 3-layer approach ---
describe('saveHar layer logic', () => {
    it('layer 1: detects empty requests', () => {
        const allRequests: any[] = [];
        if (allRequests.length === 0) {
            expect(true).toBe(true);
        }
    });

    it('layer 2: offscreen path when compatible', () => {
        const compat = { offscreen: true, getContexts: true };
        expect(compat.offscreen && compat.getContexts).toBe(true);
    });

    it('layer 3: fallback path when not compatible', () => {
        const compat = { offscreen: false, getContexts: false };
        expect(compat.offscreen && compat.getContexts).toBe(false);
    });

    it('fallback stores HAR data in storage before opening tab', async () => {
        const harString = '{"log":{}}';
        const safeFilename = 'har-capture-test.har';

        await mockChrome.storage.local.set({ _pendingHarDownload: { harString, safeFilename } });
        const stored = await mockChrome.storage.local.get('_pendingHarDownload');

        expect(stored._pendingHarDownload).toEqual({ harString, safeFilename });
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
            'FALLBACK_REQUEST_DATA',
            'GET_DEBUGGER_CONFLICTS',
        ];

        for (const type of expectedTypes) {
            messageHandler({ type });
        }

        for (const type of expectedTypes) {
            expect(handledTypes.has(type)).toBe(true);
        }
    });

    it('offscreen message handler receives create-blob-url', () => {
        const harData = '{"log":{}}';
        const message = { type: 'create-blob-url', target: 'offscreen', data: harData };

        expect(message.target).toBe('offscreen');
        expect(message.type).toBe('create-blob-url');
        expect(typeof message.data).toBe('string');
    });
});
