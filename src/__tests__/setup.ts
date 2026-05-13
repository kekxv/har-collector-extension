// src/__tests__/setup.ts
// Chrome extension API mock for vitest
/* eslint-disable @typescript-eslint/no-explicit-any */

class MockChromeStorage {
    private data: Record<string, any> = {};

    get = vi.fn(async (keys: string | string[] | Record<string, any> | null): Promise<Record<string, any>> => {
        if (keys === null) return { ...this.data };
        if (Array.isArray(keys)) {
            const result: Record<string, any> = {};
            for (const key of keys) result[key] = this.data[key];
            return result;
        }
        if (typeof keys === 'object') {
            const result: Record<string, any> = {};
            for (const key of Object.keys(keys)) result[key] = this.data[key] ?? keys[key];
            return result;
        }
        return { [keys]: this.data[keys] };
    });

    set = vi.fn(async (items: Record<string, any>): Promise<void> => {
        Object.assign(this.data, items);
    });

    remove = vi.fn(async (keys: string | string[]): Promise<void> => {
        if (Array.isArray(keys)) {
            for (const key of keys) delete this.data[key];
        } else {
            delete this.data[keys];
        }
    });

    clear() {
        this.data = {};
    }
}

export const mockStorage = new MockChromeStorage();

export const mockChrome = {
    storage: {
        local: {
            get: mockStorage.get,
            set: mockStorage.set,
            remove: mockStorage.remove,
        },
    },
    runtime: {
        lastError: null as chrome.runtime.LastError | null,
        getURL: (path: string) => `chrome-extension://mock-id/${path}`,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        getContexts: vi.fn().mockResolvedValue([]),
    },
    debugger: {
        attach: vi.fn((_target: any, _version: any, callback: () => void) => { callback(); }),
        detach: vi.fn().mockResolvedValue(undefined),
        sendCommand: vi.fn((_target: any, _method: any, _params: any, callback: (r: any) => void) => { if (callback) callback({}); }),
        getTargets: vi.fn().mockResolvedValue([]),
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
        query: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 1 }),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: {
        download: vi.fn((_options: any, callback: (id: number) => void) => { if (callback) callback(1); }),
    },
    offscreen: {
        createDocument: vi.fn().mockResolvedValue(undefined),
        Reason: { BLOBS: 'blobs' as any },
    },
    alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    },
};

// Replace global chrome with mock
(globalThis as any).chrome = mockChrome;

// Reset mock data and call history between tests (preserves mock implementations)
beforeEach(() => {
    (mockStorage as any).data = {};
    (mockChrome.runtime as any).lastError = null;
    // Clear call history on all spies
    mockStorage.get.mockClear();
    mockStorage.set.mockClear();
    mockStorage.remove.mockClear();
    mockChrome.runtime.sendMessage.mockClear();
    mockChrome.runtime.getContexts.mockClear();
    mockChrome.runtime.onMessage.addListener.mockClear();
    mockChrome.runtime.onInstalled.addListener.mockClear();
    mockChrome.debugger.attach.mockClear();
    mockChrome.debugger.detach.mockClear();
    mockChrome.debugger.sendCommand.mockClear();
    mockChrome.debugger.getTargets.mockClear();
    mockChrome.debugger.onEvent.addListener.mockClear();
    mockChrome.debugger.onDetach.addListener.mockClear();
    mockChrome.tabs.query.mockClear();
    mockChrome.tabs.create.mockClear();
    mockChrome.downloads.download.mockClear();
    mockChrome.offscreen.createDocument.mockClear();
});
