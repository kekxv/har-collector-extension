// src/fallback/har-builder-direct.ts
// Direct IndexedDB access for HAR building — runs in the fallback page (tab context).
// Falls back to chrome.runtime.sendMessage if direct access fails.

import { countRequests, iterateRequestsBatched, assembleBodies } from '../lib/idb-cursor.js';
export { countRequests } from '../lib/idb-cursor.js';
import { buildHarEntry, estimateEntrySize } from '../lib/har-builder.js';
import { CHUNK_SIZE_ENTRIES } from '../lib/streaming-har.js';

const MAX_OUTPUT_BYTES = 25 * 1024 * 1024; // 25MB

export interface HarChunkResult {
    json: string;
    filename: string;
    entryCount: number;
    hasMore: boolean;
    total: number;
}

/**
 * Estimates total chunks by scanning bodyInfo from metadata.
 */
export async function estimateTotalChunks(): Promise<number> {
    try {
        let estimatedBytes = 0;
        let entryCount = 0;
        for await (const batch of iterateRequestsBatched({ batchSize: 100 })) {
            for (const meta of batch) {
                if (!meta.response || !meta.request || !meta.request.method) continue;
                entryCount++;
                const bodyInfo = meta.bodyInfo;
                if (bodyInfo?.hasResponse) estimatedBytes += bodyInfo.responseTotalSize;
                if (bodyInfo?.hasPostData) estimatedBytes += bodyInfo.postDataTotalSize;
                estimatedBytes += 5 * 1024;
            }
        }
        if (estimatedBytes === 0 && entryCount > 0) {
            estimatedBytes = entryCount * 100 * 1024;
        }
        return estimatedBytes > 0 ? Math.max(1, Math.ceil(estimatedBytes / MAX_OUTPUT_BYTES)) : 1;
    } catch {
        return 1;
    }
}

/**
 * Generates a chunked filename with part suffix.
 */
function generateChunkFilename(base: string, index: number, total: number): string {
    const padded = String(index).padStart(3, '0');
    if (total <= 1) return base;
    const ext = base.lastIndexOf('.');
    if (ext === -1) return `${base}-${padded}`;
    return `${base.slice(0, ext)}-${padded}${base.slice(ext)}`;
}

/**
 * Builds a HAR chunk directly from IndexedDB.
 * Returns the chunk JSON and metadata.
 */
export async function buildHarChunk(
    chunkIndex: number,
    splitFiles: boolean,
    resumeKey?: [number, string] | null,
): Promise<{ result: HarChunkResult; nextKey: [number, string] | null }> {
    const batchIterator = iterateRequestsBatched({
        batchSize: 100,
        resumeAfterKey: resumeKey ?? undefined,
    });

    let collected = 0;
    let accumulatedBytes = 0;
    let hasMore = false;
    let lastKey: [number, string] | null = null;
    const entries: any[] = [];

    for await (const batch of batchIterator) {
        for (const meta of batch) {
            if (!meta.response || !meta.request || !meta.request.method) continue;

            lastKey = [meta.tabId, meta.requestId];

            // Assemble bodies on-demand
            const { responseBody, base64Encoded, postData } = await assembleBodies(meta.tabId, meta.requestId);

            const enriched = { ...meta };
            if (responseBody !== undefined) {
                enriched.responseBody = responseBody;
                enriched.base64Encoded = base64Encoded;
            }
            if (postData !== undefined) {
                enriched.request = { ...enriched.request, postData };
            }

            const entry = buildHarEntry(enriched);
            const entryBytes = estimateEntrySize(entry);

            if (accumulatedBytes + entryBytes > MAX_OUTPUT_BYTES && collected > 0) {
                hasMore = true;
                break;
            }
            if (splitFiles && collected >= CHUNK_SIZE_ENTRIES) {
                hasMore = true;
                break;
            }

            entries.push(enriched);
            accumulatedBytes += entryBytes;
            collected++;
        }
        if (hasMore) break;
    }

    if (entries.length === 0) {
        return { result: null as any, nextKey: null };
    }

    const harEntries = entries.map(buildHarEntry);
    const totalChunks = splitFiles ? await estimateTotalChunks() : 1;
    const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;
    const filename = generateChunkFilename(baseFilename, chunkIndex, totalChunks);

    const json = JSON.stringify({
        log: {
            version: "1.2",
            creator: { name: "HarCollector Extension", version: "1.0.5" },
            pages: [],
            entries: harEntries,
        },
    }, null, 2);

    return {
        result: { json, filename, entryCount: harEntries.length, hasMore, total: totalChunks },
        nextKey: hasMore && lastKey ? lastKey : null,
    };
}

/**
 * Get paginated request summaries for the manager list.
 */
export async function getRequestList(offset: number, limit: number) {
    const total = await countRequests();
    const items: Array<{ method: string; url: string; status: number | undefined; tabId: number }> = [];
    let skipped = 0;

    for await (const batch of iterateRequestsBatched({ batchSize: 100 })) {
        for (const req of batch) {
            if (!req.request || !req.request.method) continue;
            if (skipped < offset) {
                skipped++;
                continue;
            }
            items.push({
                method: req.request.method,
                url: req.request.url,
                status: req.response?.status,
                tabId: req.tabId,
            });
            if (items.length >= limit) break;
        }
        if (items.length >= limit) break;
    }

    return { items, total };
}

/**
 * Clear all data directly.
 */
export async function clearAllDataDirect(): Promise<void> {
    const { STORE_META, STORE_BODIES } = await import('../lib/idb-schema.js');
    const { openDB } = await import('../lib/idb.js');
    const db = await openDB();
    try {
        const tx = db.transaction([STORE_META, STORE_BODIES], 'readwrite');
        tx.objectStore(STORE_META).clear();
        tx.objectStore(STORE_BODIES).clear();
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}
