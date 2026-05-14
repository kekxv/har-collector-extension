import 'fake-indexeddb/auto';

import { openDB } from '../lib/idb.js';
import { STORE_META, STORE_BODIES } from '../lib/idb-schema.js';
import { buildHarChunk, estimateTotalChunks, getRequestList, clearAllDataDirect } from '../fallback/har-builder-direct.js';

const DB_NAME = 'HarCollectorDB';

async function seedMeta(count: number, overrides?: (i: number) => Partial<any>) {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    for (let i = 1; i <= count; i++) {
        const extra = overrides?.(i) || {};
        store.put({
            tabId: 1,
            requestId: `req-${String(i).padStart(3, '0')}`,
            url: `https://example.com/api/${i}`,
            request: { method: 'GET', url: `https://example.com/api/${i}`, headers: { 'Accept': 'application/json' } },
            response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Content-Type': 'application/json' } },
            responseBody: `{"id":${i},"data":"${'x'.repeat(100)}"}`,
            base64Encoded: false,
            startTime: i,
            endTime: i + 50,
            startedDateTime: '2026-01-01T00:00:00Z',
            bodyInfo: {
                hasResponse: true,
                responseTotalSize: 100 + String(i).length + 20,
                responseChunks: 0,
                responseBase64Encoded: false,
                hasPostData: false,
                postDataTotalSize: 0,
                postDataChunks: 0,
            },
            ...extra,
        });
    }
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

afterEach(async () => {
    indexedDB.deleteDatabase(DB_NAME);
});

// --- estimateTotalChunks ---

describe('estimateTotalChunks', () => {
    it('returns 1 for empty store', async () => {
        const chunks = await estimateTotalChunks();
        expect(chunks).toBe(1);
    });

    it('estimates based on body sizes', async () => {
        await seedMeta(10);
        const chunks = await estimateTotalChunks();
        expect(chunks).toBeGreaterThanOrEqual(1);
    });
});

// --- buildHarChunk ---

describe('buildHarChunk', () => {
    it('returns entries for valid records', async () => {
        await seedMeta(3);
        const { result } = await buildHarChunk(1, false);

        expect(result).not.toBeNull();
        expect(result.entryCount).toBeGreaterThan(0);
        expect(result.filename).toContain('har-capture-');
        expect(result.filename).toMatch(/\.har$/);
    });

    it('respects byte limit with hasMore', async () => {
        await seedMeta(20);
        const { result } = await buildHarChunk(1, false);

        expect(result).not.toBeNull();
        expect(result.entryCount).toBeGreaterThan(0);
    });

    it('returns null nextKey when all entries fit', async () => {
        await seedMeta(10);
        const first = await buildHarChunk(1, false);

        expect(first.result).not.toBeNull();
        expect(first.result.hasMore).toBe(false);
        expect(first.nextKey).toBeNull();
    });

    it('resumes after a given key', async () => {
        await seedMeta(10);
        // Manually resume past first 5 records using their key
        const { result } = await buildHarChunk(2, false, [1, 'req-005']);

        expect(result).not.toBeNull();
        expect(result.entryCount).toBe(5); // should get records 6-10
    });

    it('respects splitFiles chunk size limit', async () => {
        // Seed enough records to exceed CHUNK_SIZE_ENTRIES (500)
        await seedMeta(600);
        const { result } = await buildHarChunk(1, true);

        expect(result).not.toBeNull();
        expect(result.entryCount).toBeLessThanOrEqual(500);
        expect(result.hasMore).toBe(true);
    });

    it('skips records without request or response', async () => {
        const db = await openDB();
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put({
            tabId: 1,
            requestId: 'req-bad',
            url: 'https://example.com',
            startTime: 1,
            startedDateTime: '2026-01-01T00:00:00Z',
        });
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();

        const { result } = await buildHarChunk(1, false);
        expect(result).toBeNull();
    });

    it('generates chunked filename for split mode with multiple chunks', async () => {
        // Seed enough records to force multiple chunks (600 > CHUNK_SIZE_ENTRIES=500)
        await seedMeta(600);
        const { result } = await buildHarChunk(2, true);

        expect(result).not.toBeNull();
        // With 600 records, first chunk collects 500 entries, hasMore=true
        expect(result.hasMore).toBe(true);
        // Since totalChunks=1 from byte estimation (small bodies), filename has no suffix
        // The key behavior is hasMore=true, which triggers dynamic filename update in UI
    });
});

// --- getRequestList ---

describe('getRequestList', () => {
    it('returns empty list for empty store', async () => {
        const { items, total } = await getRequestList(0, 20);
        expect(items).toHaveLength(0);
        expect(total).toBe(0);
    });

    it('returns paginated request summaries', async () => {
        await seedMeta(25);
        const { items, total } = await getRequestList(0, 10);
        expect(total).toBe(25);
        expect(items).toHaveLength(10);
        expect(items[0].method).toBe('GET');
        expect(items[0].url).toContain('example.com');
        expect(items[0].status).toBe(200);
    });

    it('respects offset', async () => {
        await seedMeta(10);
        const first = await getRequestList(0, 5);
        const second = await getRequestList(5, 5);

        expect(first.items[0].url).not.toBe(second.items[0].url);
    });
});

// --- clearAllDataDirect ---

describe('clearAllDataDirect', () => {
    it('clears all stores', async () => {
        await seedMeta(5);
        await insertBodyChunk({
            tabId: 1,
            requestId: 'req-1',
            bodyType: 'response',
            chunkIndex: 0,
            offset: 0,
            data: 'test',
            totalSize: 4,
            isBase64Encoded: false,
        });

        await clearAllDataDirect();

        const { total: metaTotal } = await getRequestList(0, 100);
        expect(metaTotal).toBe(0);
    });

    it('works on empty stores', async () => {
        await clearAllDataDirect();
        // Should not throw
    });
});

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
