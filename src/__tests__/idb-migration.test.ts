// src/__tests__/idb-migration.test.ts

import 'fake-indexeddb/auto';

import { DB_NAME, STORE_META, STORE_BODIES, STORE_METADATA, BODY_CHUNK_MAX_SIZE } from '../lib/idb-schema.js';
import { splitBodyIntoChunks, migrateV1ToV2 } from '../lib/idb-migration.js';

// --- splitBodyIntoChunks (pure function) ---

describe('splitBodyIntoChunks', () => {
    it('returns single chunk for small body', () => {
        const result = splitBodyIntoChunks('hello world', 1000);
        expect(result).toHaveLength(1);
        expect(result[0].chunkIndex).toBe(0);
        expect(result[0].offset).toBe(0);
        expect(result[0].data).toBe('hello world');
    });

    it('splits body at byte boundaries', () => {
        // Create a body larger than 10 bytes to test splitting
        const body = 'a'.repeat(30);
        const result = splitBodyIntoChunks(body, 10);

        expect(result.length).toBeGreaterThan(1);
        // Verify chunk data reconstructs to original
        const reconstructed = result.map(r => r.data).join('');
        expect(reconstructed).toBe(body);
        // Verify offsets are sequential
        expect(result[0].offset).toBe(0);
        expect(result[1].offset).toBe(10);
        expect(result[2].offset).toBe(20);
    });

    it('handles UTF-8 boundary splitting', () => {
        // Chinese characters are 3 bytes each in UTF-8
        const body = '你好世界'; // 12 bytes total
        const result = splitBodyIntoChunks(body, 5);

        // Should not cut a multi-byte character in half
        const reconstructed = result.map(r => r.data).join('');
        expect(reconstructed).toBe(body);
    });

    it('handles empty string', () => {
        const result = splitBodyIntoChunks('', 100);
        expect(result).toHaveLength(1);
        expect(result[0].data).toBe('');
    });

    it('handles exactly maxSize body', () => {
        const body = 'a'.repeat(100);
        const result = splitBodyIntoChunks(body, 100);
        expect(result).toHaveLength(1);
        expect(result[0].data).toBe(body);
    });
});

// --- migrateV1ToV2 ---

describe('migrateV1ToV2', () => {
    async function setupLegacyDB(records: any[]) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const database = req.result;
                database.createObjectStore('requests', { keyPath: ['tabId', 'requestId'] });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const tx = db.transaction('requests', 'readwrite');
        const store = tx.objectStore('requests');
        for (const record of records) {
            store.put(record);
        }
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        return db;
    }

    async function openDB(): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 2);
            req.onupgradeneeded = (event) => {
                const database = req.result;
                const oldVersion = event.oldVersion ?? 0;
                const tx = req.transaction!;

                if (oldVersion < 1 && !database.objectStoreNames.contains('requests')) {
                    database.createObjectStore('requests', { keyPath: ['tabId', 'requestId'] });
                }

                if (oldVersion < 2) {
                    if (!database.objectStoreNames.contains(STORE_META)) {
                        database.createObjectStore(STORE_META, { keyPath: ['tabId', 'requestId'] });
                    }
                    if (!database.objectStoreNames.contains(STORE_BODIES)) {
                        database.createObjectStore(STORE_BODIES, { keyPath: ['tabId', 'requestId', 'bodyType', 'chunkIndex'] });
                    }
                    if (!database.objectStoreNames.contains(STORE_METADATA)) {
                        database.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                    }

                    if (oldVersion === 1 && database.objectStoreNames.contains('requests')) {
                        migrateV1ToV2(database, tx);
                    }
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function countStore(db: IDBDatabase, storeName: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function getAllFromStore(db: IDBDatabase, storeName: string): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    afterEach(async () => {
        indexedDB.deleteDatabase(DB_NAME);
    });

    it('migrates a single record from legacy to v2 schema', async () => {
        await setupLegacyDB([{
            tabId: 1,
            requestId: 'req-1',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            responseBody: '<html>Hello</html>',
            base64Encoded: false,
            startedDateTime: '2026-01-01T00:00:00Z',
            startTime: 0,
            endTime: 100,
        }]);

        const db = await openDB();
        expect(db.objectStoreNames.contains('requests')).toBe(false);
        expect(await countStore(db, STORE_META)).toBe(1);
        expect(await countStore(db, STORE_BODIES)).toBe(1);

        const metas = await getAllFromStore(db, STORE_META);
        expect(metas[0].request.method).toBe('GET');
        expect(metas[0].bodyInfo?.hasResponse).toBe(true);

        const bodies = await getAllFromStore(db, STORE_BODIES);
        expect(bodies[0].bodyType).toBe('response');
        expect(bodies[0].data).toBe('<html>Hello</html>');

        db.close();
    });

    it('splits large response bodies into chunks', async () => {
        const largeBody = 'x'.repeat(BODY_CHUNK_MAX_SIZE + 1000);
        await setupLegacyDB([{
            tabId: 1,
            requestId: 'req-large',
            url: 'https://example.com/large',
            request: { method: 'GET', url: 'https://example.com/large', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'application/octet-stream', headers: {} },
            responseBody: largeBody,
            base64Encoded: false,
            startedDateTime: '2026-01-01T00:00:00Z',
            startTime: 0,
            endTime: 100,
        }]);

        const db = await openDB();
        const bodies = await getAllFromStore(db, STORE_BODIES);
        expect(bodies.length).toBeGreaterThan(1);

        const reconstructed = bodies
            .sort((a, b) => a.offset - b.offset)
            .map(b => b.data)
            .join('');
        expect(reconstructed).toBe(largeBody);

        const metas = await getAllFromStore(db, STORE_META);
        expect(metas[0].bodyInfo.responseChunks).toBe(bodies.length);
        expect(metas[0].request.postData).toBe(undefined);

        db.close();
    });

    it('splits large postData into chunks', async () => {
        const largePostData = 'y'.repeat(BODY_CHUNK_MAX_SIZE + 500);
        await setupLegacyDB([{
            tabId: 1,
            requestId: 'req-post',
            url: 'https://example.com/api',
            request: { method: 'POST', url: 'https://example.com/api', headers: {}, postData: largePostData },
            response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} },
            responseBody: '{"ok":true}',
            base64Encoded: false,
            startedDateTime: '2026-01-01T00:00:00Z',
            startTime: 0,
            endTime: 100,
        }]);

        const db = await openDB();
        const bodies = await getAllFromStore(db, STORE_BODIES);
        const requestBodies = bodies.filter(b => b.bodyType === 'request');
        expect(requestBodies.length).toBeGreaterThan(1);

        const reconstructed = requestBodies
            .sort((a, b) => a.offset - b.offset)
            .map(b => b.data)
            .join('');
        expect(reconstructed).toBe(largePostData);

        const metas = await getAllFromStore(db, STORE_META);
        expect(metas[0].bodyInfo.hasPostData).toBe(true);
        expect(metas[0].request.postData).toBe(undefined);

        db.close();
    });

    it('writes version metadata', async () => {
        await setupLegacyDB([]);

        const db = await openDB();
        const versionEntry = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction(STORE_METADATA, 'readonly');
            const req = tx.objectStore(STORE_METADATA).get('version');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        expect(versionEntry.value).toBe(2);

        db.close();
    });

    it('handles records without responseBody', async () => {
        await setupLegacyDB([{
            tabId: 1,
            requestId: 'req-empty',
            url: 'https://example.com',
            request: { method: 'GET', url: 'https://example.com', headers: {} },
            response: { status: 200, statusText: 'OK', mimeType: 'text/html', headers: {} },
            startedDateTime: '2026-01-01T00:00:00Z',
            startTime: 0,
            endTime: 100,
        }]);

        const db = await openDB();
        expect(await countStore(db, STORE_META)).toBe(1);
        expect(await countStore(db, STORE_BODIES)).toBe(0);

        const metas = await getAllFromStore(db, STORE_META);
        expect(metas[0].bodyInfo.hasResponse).toBe(false);
        expect(metas[0].bodyInfo.hasPostData).toBe(false);

        db.close();
    });
});
