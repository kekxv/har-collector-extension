// src/lib/idb.ts
// Unified IndexedDB open function with schema version upgrade handling.

import { DB_NAME, DB_VERSION, STORE_META, STORE_BODIES, STORE_METADATA } from './idb-schema.js';
import { migrateV1ToV2 } from './idb-migration.js';

export function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = request.result;
            const oldVersion = event.oldVersion ?? 0;
            const tx = request.transaction!;

            // v0 → v1: create legacy requests store (for fresh installs before migration)
            if (oldVersion < 1 && !db.objectStoreNames.contains('requests')) {
                db.createObjectStore('requests', { keyPath: ['tabId', 'requestId'] });
            }

            // v1 → v2: create new stores and migrate
            if (oldVersion < 2) {
                if (!db.objectStoreNames.contains(STORE_META)) {
                    db.createObjectStore(STORE_META, { keyPath: ['tabId', 'requestId'] });
                }
                if (!db.objectStoreNames.contains(STORE_BODIES)) {
                    db.createObjectStore(STORE_BODIES, { keyPath: ['tabId', 'requestId', 'bodyType', 'chunkIndex'] });
                }
                if (!db.objectStoreNames.contains(STORE_METADATA)) {
                    db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
                }

                // Run migration if legacy store exists
                if (oldVersion === 1 && db.objectStoreNames.contains('requests')) {
                    migrateV1ToV2(db, tx);
                }
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
