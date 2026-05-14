// src/lib/idb-schema.ts
// IndexedDB constants, schema version, and type definitions.

export const DB_NAME = 'HarCollectorDB';
export const DB_VERSION = 2;
export const STORE_META = 'requests_meta';
export const STORE_BODIES = 'request_bodies';
export const STORE_METADATA = 'db_metadata';
export const BODY_CHUNK_MAX_SIZE = 35 * 1024 * 1024; // 35MB

export interface BodyInfo {
    hasResponse: boolean;
    responseTotalSize: number;
    responseChunks: number;
    responseBase64Encoded: boolean;
    hasPostData: boolean;
    postDataTotalSize: number;
    postDataChunks: number;
}

export interface RequestMeta {
    tabId: number;
    requestId: string;
    url: string;
    request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        postData?: string;
    };
    response?: {
        status: number;
        statusText: string;
        mimeType: string;
        headers: Record<string, string>;
    };
    responses: unknown[];
    startedDateTime: string;
    startTime: number;
    endTime?: number;
    encodedDataLength?: number;
    bodyInfo?: BodyInfo;
}

export interface RequestBodyChunk {
    tabId: number;
    requestId: string;
    bodyType: 'response' | 'request';
    chunkIndex: number;
    offset: number;
    data: string;
    totalSize: number;
    isBase64Encoded: boolean;
}
