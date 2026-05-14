// src/lib/idb-cursor.ts
// Batched IndexedDB cursor reading — reads metadata only (no body data).
// Body assembly via assembleBodies() from request_bodies store.

import { openDB } from './idb.js';
import { STORE_META, STORE_BODIES } from './idb-schema.js';
import type { RequestBodyChunk } from './idb-schema.js';

const DB_NAME = 'HarCollectorDB';

/**
 * Returns total record count from metadata store. O(1) IndexedDB operation.
 */
export async function countRequests(): Promise<number> {
    const db = await openDB();
    try {
        const tx = db.transaction(STORE_META, 'readonly');
        const count = await new Promise<number>((resolve, reject) => {
            const req = tx.objectStore(STORE_META).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return count;
    } finally {
        db.close();
    }
}

/**
 * Async generator that yields batches of metadata records from IndexedDB using a cursor.
 * Keeps memory bounded at `batchSize` records. Does NOT include body data.
 */
export async function* iterateRequestsBatched(
    options?: { batchSize?: number; resumeAfterKey?: [number, string] }
): AsyncGenerator<any[]> {
    const db = await openDB();
    const batchSize = options?.batchSize ?? 100;
    const resumeAfter = options?.resumeAfterKey;

    try {
        const tx = db.transaction(STORE_META, 'readonly');
        const store = tx.objectStore(STORE_META);

        type Item = { type: 'value'; value: unknown } | { type: 'done' } | { type: 'error'; error: Error };

        const queue: Item[] = [];
        let queueResolve: ((item: Item) => void) | null = null;

        function push(item: Item) {
            if (queueResolve) {
                queueResolve(item);
                queueResolve = null;
            } else {
                queue.push(item);
            }
        }

        function pull(): Promise<Item> {
            if (queue.length > 0) return Promise.resolve(queue.shift()!);
            return new Promise(resolve => { queueResolve = resolve; });
        }

        const cursorReq = store.openCursor();
        let skipping = !!resumeAfter;

        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) { push({ type: 'done' }); return; }

            // Skip past the resume key
            if (skipping && resumeAfter) {
                const key = cursor.key as [number, string];
                if (key[0] < resumeAfter[0] || (key[0] === resumeAfter[0] && key[1] <= resumeAfter[1])) {
                    cursor.continue();
                    return;
                }
                skipping = false;
            }

            push({ type: 'value', value: cursor.value });
            cursor.continue();
        };
        cursorReq.onerror = () => push({ type: 'error', error: cursorReq.error as Error });

        let batch: any[] = [];
        while (true) {
            const item = await pull();
            if (item.type === 'done') break;
            if (item.type === 'error') throw item.error;
            batch.push(item.value);
            if (batch.length >= batchSize) {
                yield batch;
                batch = [];
            }
        }
        if (batch.length > 0) yield batch;
    } finally {
        db.close();
    }
}

/**
 * Assembles body data for a single request from the request_bodies store.
 * Returns { responseBody, base64Encoded, postData } — undefined if not present.
 */
export async function assembleBodies(
    tabId: number,
    requestId: string,
): Promise<{ responseBody?: string; base64Encoded?: boolean; postData?: string }> {
    const db = await openDB();
    try {
        const tx = db.transaction(STORE_BODIES, 'readonly');
        const store = tx.objectStore(STORE_BODIES);

        // Use IDBKeyRange to find all chunks for this [tabId, requestId]
        // The key is [tabId, requestId, bodyType, chunkIndex]
        const lowerBound = [tabId, requestId, 'request', 0];
        const upperBound = [tabId, requestId, 'response', Infinity];
        const range = IDBKeyRange.bound(lowerBound, upperBound);

        const cursorReq = store.openCursor(range);

        return new Promise((resolve, reject) => {
            const responseChunks: RequestBodyChunk[] = [];
            const requestChunks: RequestBodyChunk[] = [];

            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) {
                    // Done collecting — sort by offset and concatenate
                    responseChunks.sort((a, b) => a.offset - b.offset);
                    requestChunks.sort((a, b) => a.offset - b.offset);

                    const responseBody = responseChunks.length > 0
                        ? responseChunks.map(c => c.data).join('')
                        : undefined;
                    const base64Encoded = responseChunks.length > 0
                        ? responseChunks[0].isBase64Encoded
                        : undefined;
                    const postData = requestChunks.length > 0
                        ? requestChunks.map(c => c.data).join('')
                        : undefined;

                    resolve({ responseBody, base64Encoded, postData });
                    return;
                }

                const chunk = cursor.value as RequestBodyChunk;
                if (chunk.bodyType === 'response') {
                    responseChunks.push(chunk);
                } else {
                    requestChunks.push(chunk);
                }
                cursor.continue();
            };

            cursorReq.onerror = () => reject(cursorReq.error);
        });
    } finally {
        db.close();
    }
}

/**
 * Legacy: openDB for old `requests` store (used by getAllRequests for backward compat).
 * Only needed during migration or for reading legacy data.
 */
function openLegacyDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Reads all records from the legacy `requests` store (if it exists).
 * Used only by the legacy handleFallbackRequestData path.
 */
export async function getAllLegacyRequests(): Promise<any[]> {
    const db = await openLegacyDB();
    try {
        if (!db.objectStoreNames.contains('requests')) {
            return [];
        }
        const tx = db.transaction('requests', 'readonly');
        const result = await new Promise<any[]>((resolve, reject) => {
            const req = tx.objectStore('requests').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        return result;
    } finally {
        db.close();
    }
}
