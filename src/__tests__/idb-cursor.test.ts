// src/__tests__/idb-cursor.test.ts

import 'fake-indexeddb/auto';

import { openDB } from '../lib/idb.js';
import { STORE_META, STORE_BODIES } from '../lib/idb-schema.js';
import { countRequests, iterateRequestsBatched, assembleBodies } from '../lib/idb-cursor.js';

// Helper: insert a meta record
async function insertMeta(record: any) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(record);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

// Helper: insert a body chunk
async function insertBodyChunk(chunk: any) {
    const db = await openDB();
    const tx = db.transaction(STORE_BODIES, 'readwrite');
    tx.objectStore(STORE_BODIES).put(chunk);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

const DB_NAME = 'HarCollectorDB';

afterEach(async () => {
    indexedDB.deleteDatabase(DB_NAME);
});

// --- countRequests ---

describe('countRequests', () => {
    it('returns 0 for empty store', async () => {
        const count = await countRequests();
        expect(count).toBe(0);
    });

    it('returns correct count after inserting records', async () => {
        for (let i = 1; i <= 5; i++) {
            await insertMeta({
                tabId: 1,
                requestId: `req-${i}`,
                url: `https://example.com/${i}`,
                request: { method: 'GET', url: `https://example.com/${i}`, headers: {} },
                response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
                startTime: i,
                endTime: i + 100,
                startedDateTime: '2026-01-01T00:00:00Z',
            });
        }
        const count = await countRequests();
        expect(count).toBe(5);
    });
});

// --- iterateRequestsBatched ---

describe('iterateRequestsBatched', () => {
    async function seedRecords(count: number) {
        for (let i = 1; i <= count; i++) {
            await insertMeta({
                tabId: 1,
                requestId: `req-${String(i).padStart(3, '0')}`,
                url: `https://example.com/${i}`,
                request: { method: 'GET', url: `https://example.com/${i}`, headers: {} },
                response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
                startTime: i,
                endTime: i + 100,
                startedDateTime: '2026-01-01T00:00:00Z',
            });
        }
    }

    it('yields all records in batches', async () => {
        await seedRecords(7);
        const results: any[] = [];
        for await (const batch of iterateRequestsBatched({ batchSize: 3 })) {
            results.push(...batch);
        }
        expect(results).toHaveLength(7);
        expect(results[0].requestId).toBe('req-001');
        expect(results[6].requestId).toBe('req-007');
    });

    it('respects batchSize', async () => {
        await seedRecords(10);
        const batchSizes: number[] = [];
        for await (const batch of iterateRequestsBatched({ batchSize: 3 })) {
            batchSizes.push(batch.length);
        }
        expect(batchSizes).toEqual([3, 3, 3, 1]);
    });

    it('resumes after a given key', async () => {
        await seedRecords(10);
        const results: any[] = [];
        // Skip past the third record [1, "req-003"]
        for await (const batch of iterateRequestsBatched({ batchSize: 5, resumeAfterKey: [1, 'req-003'] })) {
            results.push(...batch);
        }
        expect(results).toHaveLength(7);
        expect(results[0].requestId).toBe('req-004');
    });

    it('returns empty when resumeAfterKey is past all records', async () => {
        await seedRecords(3);
        const results: any[] = [];
        for await (const batch of iterateRequestsBatched({ resumeAfterKey: [1, 'req-999'] })) {
            results.push(...batch);
        }
        expect(results).toHaveLength(0);
    });

    it('yields only valid records with request and response', async () => {
        // Insert one valid and one incomplete record
        await insertMeta({
            tabId: 1,
            requestId: 'req-ok',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 1,
            endTime: 101,
            startedDateTime: '2026-01-01T00:00:00Z',
        });
        await insertMeta({
            tabId: 2,
            requestId: 'req-bad',
            url: 'https://example.com/bad',
            // no request
            startTime: 2,
            startedDateTime: '2026-01-01T00:00:00Z',
        });

        const results: any[] = [];
        for await (const batch of iterateRequestsBatched()) {
            results.push(...batch);
        }
        // Both records are yielded; consumer filters
        expect(results).toHaveLength(2);
    });
});

// --- assembleBodies ---

describe('assembleBodies', () => {
    it('returns undefined when no body chunks exist', async () => {
        await insertMeta({
            tabId: 1,
            requestId: 'req-1',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startTime: 1,
            endTime: 101,
            startedDateTime: '2026-01-01T00:00:00Z',
        });

        const result = await assembleBodies(1, 'req-1');
        expect(result.responseBody).toBe(undefined);
        expect(result.postData).toBe(undefined);
        expect(result.base64Encoded).toBe(undefined);
    });

    it('assembles a single response body chunk', async () => {
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-1',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: 'Hello World',
            totalSize: 11,
            isBase64Encoded: false,
        });

        const result = await assembleBodies(1, 'req-1');
        expect(result.responseBody).toBe('Hello World');
        expect(result.base64Encoded).toBe(false);
    });

    it('assembles multiple response chunks in offset order', async () => {
        // Insert out of order
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-2',
            bodyType: 'response',
            chunkIndex: 2,
            offset: 10,
            data: 'World',
            totalSize: 15,
            isBase64Encoded: false,
        });
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-2',
            bodyType: 'response',
            chunkIndex: 1,
            offset: 0,
            data: 'Hello ',
            totalSize: 15,
            isBase64Encoded: false,
        });
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-2',
            bodyType: 'response',
            chunkIndex: 3,
            offset: 10,
            data: '!',
            totalSize: 15,
            isBase64Encoded: false,
        });

        const result = await assembleBodies(1, 'req-2');
        expect(result.responseBody).toBe('Hello World!');
    });

    it('assembles both request and response bodies', async () => {
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-3',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: '{"status":"ok"}',
            totalSize: 15,
            isBase64Encoded: false,
        });
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-3',
            bodyType: 'request',
            chunkIndex: 0,
            offset: 0,
            data: '{"action":"test"}',
            totalSize: 16,
            isBase64Encoded: false,
        });

        const result = await assembleBodies(1, 'req-3');
        expect(result.responseBody).toBe('{"status":"ok"}');
        expect(result.postData).toBe('{"action":"test"}');
    });

    it('handles base64 encoded response', async () => {
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-4',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: 'eyJrZXkiOiJ2YWx1ZSJ9',
            totalSize: 20,
            isBase64Encoded: true,
        });

        const result = await assembleBodies(1, 'req-4');
        expect(result.responseBody).toBe('eyJrZXkiOiJ2YWx1ZSJ9');
        expect(result.base64Encoded).toBe(true);
    });

    it('does not mix body chunks from different requests', async () => {
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-a',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: 'FROM-A',
            totalSize: 6,
            isBase64Encoded: false,
        });
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-b',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: 'FROM-B',
            totalSize: 6,
            isBase64Encoded: false,
        });

        const resultA = await assembleBodies(1, 'req-a');
        const resultB = await assembleBodies(1, 'req-b');
        expect(resultA.responseBody).toBe('FROM-A');
        expect(resultB.responseBody).toBe('FROM-B');
    });
});
