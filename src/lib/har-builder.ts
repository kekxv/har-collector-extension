// src/lib/har-builder.ts
// Pure functions for building HAR entries — easily testable without chrome runtime

const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

export interface NetworkRequest {
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
    responseBody?: string;
    base64Encoded?: boolean;
    encodedDataLength?: number;
    startTime: number;
    endTime: number;
    startedDateTime: string;
}

export interface HarEntry {
    startedDateTime: string;
    time: number;
    request: {
        method: string;
        url: string;
        httpVersion: string;
        cookies: never[];
        headers: Array<{ name: string; value: string }>;
        queryString: never[];
        postData?: { mimeType: string; text: string };
        headersSize: -1;
        bodySize: number;
    };
    response: {
        status: number;
        statusText: string;
        httpVersion: string;
        cookies: never[];
        headers: Array<{ name: string; value: string }>;
        content: {
            size: number;
            mimeType: string;
            text: string | undefined;
            encoding: string | undefined;
        };
        redirectURL: string;
        headersSize: -1;
        bodySize: number;
    };
    cache: Record<string, never>;
    timings: { send: -1; wait: -1; receive: -1; ssl: -1; connect: -1; dns: -1; blocked: -1 };
}

export interface HarLog {
    log: {
        version: string;
        creator: { name: string; version: string };
        pages: never[];
        entries: HarEntry[];
    };
}

/**
 * Validates whether a string is valid base64.
 */
export function isValidBase64(str: string): boolean {
    return BASE64_REGEX.test(str);
}

/**
 * Calculates content size from base64-encoded body text.
 * Returns byte length if valid base64, otherwise string length.
 */
export function calculateContentSize(bodyText: string, base64Encoded: boolean): number {
    if (!base64Encoded) return bodyText.length;
    if (!isValidBase64(bodyText)) return bodyText.length;

    try {
        return atob(bodyText).length;
    } catch {
        return bodyText.length;
    }
}

/**
 * Builds a single HAR entry from a network request record.
 */
export function buildHarEntry(req: NetworkRequest): HarEntry {
    const time = (req.endTime - req.startTime) * 1000;
    const bodyText = req.responseBody || "";
    const contentSize = calculateContentSize(bodyText, !!req.base64Encoded);

    return {
        startedDateTime: req.startedDateTime,
        time: time > 0 ? time : 0,
        request: {
            method: req.request.method,
            url: req.request.url,
            httpVersion: "HTTP/2.0",
            cookies: [],
            headers: Object.entries(req.request.headers).map(([name, value]) => ({ name, value: String(value) })),
            queryString: [],
            postData: req.request.postData ? {
                mimeType: req.request.headers['Content-Type'] || '',
                text: req.request.postData
            } : undefined,
            headersSize: -1,
            bodySize: req.request.postData ? req.request.postData.length : 0,
        },
        response: {
            status: req.response!.status,
            statusText: req.response!.statusText,
            httpVersion: "HTTP/2.0",
            cookies: [],
            headers: Object.entries(req.response!.headers).map(([name, value]) => ({ name, value: String(value) })),
            content: {
                size: contentSize,
                mimeType: req.response!.mimeType,
                text: req.responseBody,
                encoding: req.base64Encoded ? "base64" : undefined,
            },
            redirectURL: req.response!.headers['Location'] || req.response!.headers['location'] || '',
            headersSize: -1,
            bodySize: req.encodedDataLength || 0,
        },
        cache: {},
        timings: { send: -1, wait: -1, receive: -1, ssl: -1, connect: -1, dns: -1, blocked: -1 },
    };
}

/**
 * Estimates the byte size of a HAR entry when serialized to JSON.
 */
export function estimateEntrySize(entry: HarEntry): number {
    return new TextEncoder().encode(JSON.stringify(entry)).length;
}

/**
 * Builds a complete HAR log from an array of network request records.
 * Only includes requests that have a response.
 */
export function buildHarLog(allRequests: NetworkRequest[], version = "1.0.5"): HarLog {
    const entries = allRequests
        .filter(r => r.response && r.request && r.request.method)
        .map(buildHarEntry);

    return {
        log: {
            version: "1.2",
            creator: { name: "HarCollector Extension", version },
            pages: [],
            entries,
        },
    };
}

/**
 * Generates a safe filename for HAR download.
 */
export function generateHarFilename(date?: Date): string {
    const d = date || new Date();
    return `har-capture-${d.toISOString().replace(/:/g, '-').replace(/\./g, '_')}.har`;
}
