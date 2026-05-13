// src/lib/idb-cursor.ts
// Batched IndexedDB cursor reading — avoids loading all records into memory at once.

const DB_NAME = 'HarCollectorDB';
const STORE_NAME = 'requests';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: ['tabId', 'requestId'] });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Returns total record count without loading data. O(1) IndexedDB operation.
 */
export async function countRequests(): Promise<number> {
    const db = await openDB();
    try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const count = await new Promise<number>((resolve, reject) => {
            const req = tx.objectStore(STORE_NAME).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return count;
    } finally {
        db.close();
    }
}

/**
 * Async generator that yields batches of records from IndexedDB using a cursor.
 * Keeps memory bounded at `batchSize` records.
 */
export async function* iterateRequestsBatched(
    options?: { batchSize?: number }
): AsyncGenerator<any[]> {
    const db = await openDB();
    const batchSize = options?.batchSize ?? 100;

    try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        // Bridge IndexedDB's event model to async generator via a Promise queue
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
        cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) { push({ type: 'done' }); return; }
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
