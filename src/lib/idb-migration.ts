// src/lib/idb-migration.ts
// V1 → V2 migration: split monolithic `requests` store into meta + bodies.
// Called from `onupgradeneeded` — uses the existing version-change transaction.

import {
    DB_VERSION, STORE_META, STORE_BODIES, STORE_METADATA,
    BODY_CHUNK_MAX_SIZE,
    type RequestMeta,
    type BodyInfo,
    type RequestBodyChunk,
} from './idb-schema.js';

/**
 * Splits a body string into chunks at byte boundaries, respecting maxSize.
 * Uses TextEncoder/TextDecoder for correct UTF-8 boundary handling.
 */
export function splitBodyIntoChunks(
    body: string,
    maxSize: number = BODY_CHUNK_MAX_SIZE,
): Array<{ chunkIndex: number; offset: number; data: string }> {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);

    if (bytes.length <= maxSize) {
        return [{ chunkIndex: 0, offset: 0, data: body }];
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const chunks: Array<{ chunkIndex: number; offset: number; data: string }> = [];
    let offset = 0;
    let chunkIndex = 1;

    while (offset < bytes.length) {
        let end = Math.min(offset + maxSize, bytes.length);
        while (end > offset && (bytes[end] & 0xc0) === 0x80) {
            end--;
        }
        if (end === offset) {
            end = Math.min(offset + 1, bytes.length);
        }

        chunks.push({
            chunkIndex,
            offset,
            data: decoder.decode(bytes.slice(offset, end)),
        });
        offset = end;
        chunkIndex++;
    }

    return chunks;
}

/**
 * Migrates data from the legacy `requests` store (v1) to the new
 * `requests_meta`, `request_bodies`, and `db_metadata` stores (v2).
 *
 * Must be called from `onupgradeneeded`. Uses the version-change
 * transaction `tx` — do NOT create new transactions.
 */
export function migrateV1ToV2(db: IDBDatabase, tx: IDBTransaction): void {
    const oldStore = tx.objectStore('requests');
    const metaStore = tx.objectStore(STORE_META);
    const bodiesStore = tx.objectStore(STORE_BODIES);
    const versionStore = tx.objectStore(STORE_METADATA);

    // Write schema version
    versionStore.put({ key: 'version', value: DB_VERSION });

    const cursorReq = oldStore.openCursor();

    cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
            // Done — delete legacy store
            db.deleteObjectStore('requests');
            return;
        }

        const record = cursor.value;
        const { responseBody, base64Encoded } = record;
        const postData = record.request?.postData;

        // Build meta (without body fields)
        const meta: RequestMeta = {
            tabId: record.tabId,
            requestId: record.requestId,
            url: record.url || record.request?.url || '',
            request: {
                method: record.request?.method || '',
                url: record.request?.url || '',
                headers: record.request?.headers || {},
                postData: postData !== undefined && typeof postData === 'string' && new TextEncoder().encode(postData).length <= BODY_CHUNK_MAX_SIZE
                    ? postData
                    : undefined,
            },
            response: record.response,
            responses: record.responses || [],
            startedDateTime: record.startedDateTime || '',
            startTime: record.startTime || 0,
            endTime: record.endTime,
            encodedDataLength: record.encodedDataLength,
        };

        // Build bodyInfo
        const bodyInfo: BodyInfo = {
            hasResponse: false,
            responseTotalSize: 0,
            responseChunks: 0,
            responseBase64Encoded: !!base64Encoded,
            hasPostData: false,
            postDataTotalSize: 0,
            postDataChunks: 0,
        };

        // Handle responseBody
        if (typeof responseBody === 'string' && responseBody.length > 0) {
            const bodySize = new TextEncoder().encode(responseBody).length;
            const chunks = splitBodyIntoChunks(responseBody);

            for (const chunk of chunks) {
                const bodyChunk: RequestBodyChunk = {
                    tabId: record.tabId,
                    requestId: record.requestId,
                    bodyType: 'response',
                    chunkIndex: chunk.chunkIndex,
                    offset: chunk.offset,
                    data: chunk.data,
                    totalSize: bodySize,
                    isBase64Encoded: !!base64Encoded,
                };
                bodiesStore.put(bodyChunk);
            }

            bodyInfo.hasResponse = true;
            bodyInfo.responseTotalSize = bodySize;
            bodyInfo.responseChunks = chunks.length;

            if (bodySize > BODY_CHUNK_MAX_SIZE) {
                delete meta.request.postData;
            }
        }

        // Handle postData
        if (typeof postData === 'string') {
            const postDataSize = new TextEncoder().encode(postData).length;
            if (postDataSize > BODY_CHUNK_MAX_SIZE) {
                const chunks = splitBodyIntoChunks(postData);
                for (const chunk of chunks) {
                    bodiesStore.put({
                        tabId: record.tabId,
                        requestId: record.requestId,
                        bodyType: 'request',
                        chunkIndex: chunk.chunkIndex,
                        offset: chunk.offset,
                        data: chunk.data,
                        totalSize: postDataSize,
                        isBase64Encoded: false,
                    } as RequestBodyChunk);
                }

                bodyInfo.hasPostData = true;
                bodyInfo.postDataTotalSize = postDataSize;
                bodyInfo.postDataChunks = chunks.length;
                delete meta.request.postData;
            } else if (postDataSize > 0) {
                bodyInfo.hasPostData = true;
                bodyInfo.postDataTotalSize = postDataSize;
                bodyInfo.postDataChunks = 0;
            }
        }

        meta.bodyInfo = bodyInfo;
        metaStore.put(meta);

        cursor.continue();
    };

    cursorReq.onerror = () => {
        console.error('Migration cursor error:', cursorReq.error);
    };
}
