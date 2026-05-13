// src/__tests__/har-builder.test.ts
import { describe, it, expect } from 'vitest';
import {
    isValidBase64,
    calculateContentSize,
    buildHarEntry,
    buildHarLog,
    generateHarFilename,
    type NetworkRequest,
} from '../lib/har-builder';

// --- isValidBase64 ---
describe('isValidBase64', () => {
    it('returns true for valid base64 strings', () => {
        expect(isValidBase64('SGVsbG8gV29ybGQ=')).toBe(true);
        expect(isValidBase64('YWJj')).toBe(true);
        expect(isValidBase64('')).toBe(true);
        expect(isValidBase64('AA==')).toBe(true);
        expect(isValidBase64('AAA')).toBe(true);
    });

    it('returns false for invalid base64 strings', () => {
        expect(isValidBase64('not!base64')).toBe(false);
        expect(isValidBase64('has spaces')).toBe(false);
        expect(isValidBase64('{"json": true}')).toBe(false);
        expect(isValidBase64('<html>')).toBe(false);
    });
});

// --- calculateContentSize ---
describe('calculateContentSize', () => {
    it('returns string length when not base64 encoded', () => {
        expect(calculateContentSize('hello', false)).toBe(5);
    });

    it('decodes valid base64 and returns byte length', () => {
        // "hello" in base64 is "aGVsbG8=" (8 chars)
        // decoded length is 5
        expect(calculateContentSize('aGVsbG8=', true)).toBe(5);
    });

    it('falls back to string length for invalid base64', () => {
        const invalid = 'not-valid-base64!!!';
        expect(calculateContentSize(invalid, true)).toBe(invalid.length);
    });

    it('handles empty string', () => {
        expect(calculateContentSize('', false)).toBe(0);
        expect(calculateContentSize('', true)).toBe(0);
    });
});

// --- buildHarEntry ---
describe('buildHarEntry', () => {
    function makeRequest(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
        return {
            tabId: 1,
            requestId: 'req-1',
            url: 'https://example.com/api',
            request: {
                method: 'GET',
                url: 'https://example.com/api',
                headers: { 'Content-Type': 'application/json' },
            },
            response: {
                status: 200,
                statusText: 'OK',
                mimeType: 'application/json',
                headers: { 'Content-Type': 'application/json' },
            },
            responseBody: '{"ok":true}',
            base64Encoded: false,
            startTime: 100,
            endTime: 150,
            startedDateTime: '2024-01-01T00:00:00.000Z',
            ...overrides,
        };
    }

    it('builds a valid HAR entry from a network request', () => {
        const req = makeRequest();
        const entry = buildHarEntry(req);

        expect(entry.startedDateTime).toBe('2024-01-01T00:00:00.000Z');
        expect(entry.time).toBe(50000); // (150 - 100) * 1000
        expect(entry.request.method).toBe('GET');
        expect(entry.request.url).toBe('https://example.com/api');
        expect(entry.response.status).toBe(200);
        expect(entry.response.content.text).toBe('{"ok":true}');
    });

    it('calculates negative time as 0', () => {
        const req = makeRequest({ startTime: 200, endTime: 100 });
        const entry = buildHarEntry(req);
        expect(entry.time).toBe(0);
    });

    it('handles base64 encoded response body', () => {
        const req = makeRequest({
            responseBody: 'eyJvayI6dHJ1ZX0=', // {"ok":true} in base64
            base64Encoded: true,
        });
        const entry = buildHarEntry(req);
        expect(entry.response.content.encoding).toBe('base64');
        expect(entry.response.content.size).toBe(11); // byte length of {"ok":true}
    });

    it('includes postData for requests with body', () => {
        const req = makeRequest({
            request: {
                method: 'POST',
                url: 'https://example.com/api',
                headers: { 'Content-Type': 'application/json' },
                postData: '{"name":"test"}',
            },
        });
        const entry = buildHarEntry(req);
        expect(entry.request.postData).toEqual({
            mimeType: 'application/json',
            text: '{"name":"test"}',
        });
        expect(entry.request.bodySize).toBe(15);
    });

    it('handles redirect URL from headers', () => {
        const req = makeRequest({
            response: {
                status: 301,
                statusText: 'Moved',
                mimeType: 'text/html',
                headers: { 'Location': 'https://new.example.com' },
            },
        });
        const entry = buildHarEntry(req);
        expect(entry.response.redirectURL).toBe('https://new.example.com');
    });

    it('handles lowercase location header', () => {
        const req = makeRequest({
            response: {
                status: 301,
                statusText: 'Moved',
                mimeType: 'text/html',
                headers: { 'location': 'https://new.example.com' },
            },
        });
        const entry = buildHarEntry(req);
        expect(entry.response.redirectURL).toBe('https://new.example.com');
    });

    it('filters out requests without response', () => {
        const reqWithoutResponse = {
            ...makeRequest(),
            response: undefined,
        } as unknown as NetworkRequest;

        const log = buildHarLog([makeRequest(), reqWithoutResponse]);
        expect(log.log.entries).toHaveLength(1);
    });
});

// --- buildHarLog ---
describe('buildHarLog', () => {
    it('creates a complete HAR log structure', () => {
        const requests: NetworkRequest[] = [{
            tabId: 1,
            requestId: 'req-1',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        }];

        const log = buildHarLog(requests);

        expect(log.log.version).toBe('1.2');
        expect(log.log.creator.name).toBe('HarCollector Extension');
        expect(log.log.pages).toEqual([]);
        expect(log.log.entries).toHaveLength(1);
    });

    it('returns empty entries for no requests', () => {
        const log = buildHarLog([]);
        expect(log.log.entries).toHaveLength(0);
    });

    it('uses custom version string', () => {
        const log = buildHarLog([], '2.0.0');
        expect(log.log.creator.version).toBe('2.0.0');
    });

    it('filters out requests that have response but no request object', () => {
        // Simulates IndexedDB records where Network.responseReceived arrived
        // but Network.requestWillBeSent never did (or was a different requestId)
        const incompleteReq = {
            tabId: 1,
            requestId: 'req-orphan',
            url: 'https://example.com',
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        } as unknown as NetworkRequest;

        const validReq: NetworkRequest = {
            tabId: 1,
            requestId: 'req-ok',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        };

        const log = buildHarLog([validReq, incompleteReq]);
        expect(log.log.entries).toHaveLength(1);
        expect(log.log.entries[0].request.method).toBe('GET');
    });

    it('filters out requests where request.method is missing', () => {
        const noMethodReq = {
            tabId: 1,
            requestId: 'req-no-method',
            url: 'https://example.com',
            request: { method: '', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        } as unknown as NetworkRequest;

        const validReq: NetworkRequest = {
            tabId: 1,
            requestId: 'req-ok',
            url: 'https://example.com',
            request: { method: 'POST', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 0,
            endTime: 1,
            startedDateTime: '2024-01-01T00:00:00.000Z',
        };

        const log = buildHarLog([validReq, noMethodReq]);
        expect(log.log.entries).toHaveLength(1);
    });

    it('does not throw when all records are incomplete', () => {
        const allIncomplete = [
            { tabId: 1, requestId: 'r1', response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} }, startTime: 0, endTime: 1, startedDateTime: '2024-01-01T00:00:00.000Z' },
            { tabId: 2, requestId: 'r2', response: { status: 404, statusText: 'Not Found', mimeType: 'text/html', headers: {} }, startTime: 0, endTime: 1, startedDateTime: '2024-01-01T00:00:00.000Z' },
        ] as unknown as NetworkRequest[];

        const log = buildHarLog(allIncomplete);
        expect(log.log.entries).toHaveLength(0);
    });
});

// --- generateHarFilename ---
describe('generateHarFilename', () => {
    it('generates a filename with ISO timestamp format', () => {
        const date = new Date('2024-06-15T10:30:45.123Z');
        const filename = generateHarFilename(date);
        expect(filename).toBe('har-capture-2024-06-15T10-30-45_123Z.har');
    });

    it('replaces colons and dots with safe characters', () => {
        const filename = generateHarFilename(new Date('2024-01-01T00:00:00.000Z'));
        expect(filename).not.toContain(':');
        // Only the .har suffix should have a dot
        const withoutSuffix = filename.replace('.har', '');
        expect(withoutSuffix).not.toContain('.');
    });

    it('uses current time when no date provided', () => {
        const filename = generateHarFilename();
        expect(filename.startsWith('har-capture-')).toBe(true);
        expect(filename.endsWith('.har')).toBe(true);
    });
});
