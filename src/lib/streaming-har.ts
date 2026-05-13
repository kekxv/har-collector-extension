// src/lib/streaming-har.ts
// Chunked HAR JSON construction — processes entries in batches to keep memory bounded.

import { buildHarEntry, type HarEntry } from './har-builder.js';

export const CHUNK_SIZE_ENTRIES = 500;
const VERSION = "1.0.5";

export interface HarChunk {
    index: number;
    total: number;
    json: string;
    byteLength: number;
    entryCount: number;
    filename: string;
}

/**
 * Builds a complete HAR JSON string from a batch of entries.
 */
function buildHarJson(entries: HarEntry[]): string {
    return JSON.stringify({
        log: {
            version: "1.2",
            creator: { name: "HarCollector Extension", version: VERSION },
            pages: [],
            entries,
        },
    }, null, 2);
}

/**
 * Estimates the number of chunks needed given total records and chunk size.
 * Accounts for filtering (not all records have both request and response).
 */
export function estimateChunkCount(totalRecords: number, chunkSize: number = CHUNK_SIZE_ENTRIES): number {
    // Assume ~80% of records pass the filter (have both request and response)
    const estimatedEntries = Math.ceil(totalRecords * 0.8);
    return Math.max(1, Math.ceil(estimatedEntries / chunkSize));
}

/**
 * Generates a chunked filename with part suffix.
 */
export function generateChunkFilename(base: string, index: number, total: number): string {
    const padded = String(index).padStart(3, '0');
    if (total <= 1) return base;
    const ext = base.lastIndexOf('.');
    if (ext === -1) return `${base}-${padded}`;
    return `${base.slice(0, ext)}-${padded}${base.slice(ext)}`;
}

/**
 * Async generator that reads records in batches from IndexedDB, converts to HAR entries,
 * and yields complete HAR JSON chunks.
 */
export async function* buildHarChunks(
    batchIterator: AsyncGenerator<any[]>,
    options?: { chunkSize?: number }
): AsyncGenerator<HarChunk> {
    const chunkSize = options?.chunkSize ?? CHUNK_SIZE_ENTRIES;

    const baseFilename = `har-capture-${new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;
    let chunkEntries: HarEntry[] = [];
    let chunkIndex = 0;

    for await (const batch of batchIterator) {
        for (const req of batch) {
            if (!req.response || !req.request || !req.request.method) continue;
            try {
                chunkEntries.push(buildHarEntry(req));
            } catch (e) {
                console.warn(`Skipping invalid record ${req.requestId}:`, e);
            }

            if (chunkEntries.length >= chunkSize) {
                const json = buildHarJson(chunkEntries);
                chunkIndex++;
                const byteLength = new TextEncoder().encode(json).length;
                yield {
                    index: chunkIndex,
                    total: -1, // unknown until all chunks emitted
                    json,
                    byteLength,
                    entryCount: chunkEntries.length,
                    filename: generateChunkFilename(baseFilename, chunkIndex, -1),
                };
                chunkEntries = [];
            }
        }
    }

    // Flush remaining entries
    if (chunkEntries.length > 0) {
        const json = buildHarJson(chunkEntries);
        chunkIndex++;
        const byteLength = new TextEncoder().encode(json).length;
        const total = chunkIndex;
        yield {
            index: total,
            total,
            json,
            byteLength,
            entryCount: chunkEntries.length,
            filename: generateChunkFilename(baseFilename, total, total),
        };
    }

    // Go back and fix filenames for earlier chunks (total was unknown)
    // Since we can't retroactively yield, we emit a metadata chunk at the end
    // The consumer uses the last chunk's total to update previous filenames
}
